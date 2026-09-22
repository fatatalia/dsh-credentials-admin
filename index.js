/**
 * dsh-credentials-admin — host 半部分（Typert Remote Service 版）
 *
 * 在 dsh Web 设置页提供一个「凭据管理」分区：列出 / 添加 / 修改 / 删除
 * `$DSH_HOME/.credentials.yaml` 里 `refs:` 段的长期凭据。client 通过 Typert
 * remote `credentialsAdmin`（list/set/unset）调用，零 dsh 框架改动。
 *
 * 三条硬纪律（改这个文件前先读完）：
 *
 *  1. **永不回显已配置的值。** `list` 只返回 `{ name, configured }` —— 连值长度
 *     都不给。服务端没有任何"读单个 ref 明文"的方法，所以浏览器端就算被改也
 *     拿不到旧值。日志只记名字，绝不记值。
 *
 *  2. **只动 refs 段。** 行级编辑：`records:` 段（浏览器会话 secret、Models 页
 *     存的 API key）一字不改。写完立刻用 credentials-local 的
 *     `parseCredentialsDocument` 自校验 —— dsh 的解析器不接受就整体放弃，
 *     绝不落盘半成品。
 *
 *  3. **与 dsh 共用同一把写锁。** `@deepseek-ai/dsh-atomic-write` 的 withFileLock
 *     锁的是 `<file>.lock`（wx 创建），与 credentials provider 完全一致，所以
 *     "我写 refs" 与 "它写 records" 不会互相覆盖。
 *
 * 为什么自己写盘：官方接口文档明确 refs 是**只读缝** —— CredentialRef 只做
 * `env → managed store → .env` 分层解析，唯一的官方写路径 `modifyRecord` 只管
 * records。管理 refs 属于扩展能力，故自建（锁 + 自校验 + 只碰 refs 段），
 * 不修改 dsh 本体。
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { parseCredentialsDocument } from "@deepseek-ai/dsh-credentials-local";
import { RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-credentials-admin";

/** 只需要 typert（注册 remote service）。 */
export const inject = ["typert"];

/** 默认落在 dsh 的托管凭据文档；DSH_HOME 可覆盖。 */
function defaultFilename() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".credentials.yaml");
}

export const Config = z.object({
  filename: z.string().default(defaultFilename()),
  // 等待写锁的上限。dsh 侧同锁的默认等待是 2s，这里放宽一点以容忍并发窗口。
  lockWaitMs: z.number().default(5000),
});

/** 值长度上限：挡住把整个文件内容误粘贴进"值"框这类事故。 */
const MAX_VALUE_LENGTH = 8192;
/** 与 credentials-local 的 credentialRef 同族：POSIX 名，字母/下划线开头。 */
const REF_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** refs 段里的一条 `  NAME: value`。 */
const REF_ENTRY = /^ {2}([A-Za-z_][A-Za-z0-9_]*):(?: (.*))?$/;
/** 顶层键（无缩进、非注释）—— refs 段的结束边界。 */
const TOP_LEVEL = /^[^\s#]/;

// ── 纯函数：文档的行级编辑（导出供测试） ──────────────────────────────────

/**
 * 定位顶层 `refs:` 段，返回它在行数组里的范围。
 * @throws 当文档没有 refs 段（结构不对，宁可不写）。
 */
export function locateRefs(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^refs:\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) throw new Error("凭据文件里没有顶层 `refs:` 段，拒绝改写");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOP_LEVEL.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start + 1, end) };
}

/**
 * 把任意字符串编码成合法的 YAML 标量。
 * JSON 的字符串字面量恰好是合法的 YAML 双引号标量，所以直接借用它做转义，
 * 不必引入 yaml 依赖，也不会被 `:` `#` 换行等字符搞坏文档。
 */
export function encodeScalar(value) {
  if (/^[A-Za-z0-9_@./+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** 把一行里的 YAML 标量还原成字符串（只用于判断"是否为空"，不用于回显）。 */
export function decodeScalar(raw) {
  const text = (raw ?? "").trim();
  if (text === "" || text === "~" || text === "null") return "";
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "string" ? parsed : text;
    } catch {
      return text;
    }
  }
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

/** 列出 refs 段的凭据名与"是否已配置"。**永不返回值本身。** */
export function listRefs(text) {
  const { body } = locateRefs(text.split("\n"));
  const refs = [];
  for (const line of body) {
    const match = REF_ENTRY.exec(line);
    if (!match) continue;
    refs.push({ name: match[1], configured: decodeScalar(match[2]).length > 0 });
  }
  return refs;
}

/** 写入/覆盖一条 ref，返回新文本与是否覆盖了已有条目。 */
export function setRef(text, refName, value) {
  const lines = text.split("\n");
  const { start, end, body } = locateRefs(lines);
  const line = `  ${refName}: ${encodeScalar(value)}`;
  const at = body.findIndex((candidate) => REF_ENTRY.exec(candidate)?.[1] === refName);
  const next = body.slice();
  if (at >= 0) {
    next[at] = line;
  } else {
    // 插到段末，但排在尾部空行/注释之前，保持文档整洁。
    let insertAt = next.length;
    while (insertAt > 0) {
      const candidate = next[insertAt - 1].trim();
      if (candidate === "" || candidate.startsWith("#")) insertAt -= 1;
      else break;
    }
    next.splice(insertAt, 0, line);
  }
  return { text: [...lines.slice(0, start + 1), ...next, ...lines.slice(end)].join("\n"), replaced: at >= 0 };
}

/** 删除一条 ref，返回新文本与是否真的删掉了。 */
export function removeRef(text, refName) {
  const lines = text.split("\n");
  const { start, end, body } = locateRefs(lines);
  const next = body.filter((candidate) => REF_ENTRY.exec(candidate)?.[1] !== refName);
  const removed = next.length !== body.length;
  return { text: [...lines.slice(0, start + 1), ...next, ...lines.slice(end)].join("\n"), removed };
}

// ── Typert wire schemas ───────────────────────────────────────────────────
// Typert 只要求 codec.schema 是带 `parse(value)` 的对象；这里宽松放行，
// 真正的校验在方法体内（名字语法、空值、长度）。
const wireSchema = { parse: (value) => value };
const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: wireSchema });

/** 注册给 API gateway 的远程方法清单（Typert MANIFEST）。 */
const MANIFEST = {
  package: "dsh-credentials-admin",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-credentials-admin#credentialsAdmin/list",
      service: "credentialsAdmin",
      namespace: "credentialsAdmin",
      method: "list",
      invocation: { kind: "direct" },
      parameters: [],
      result: codec("dsh-credentials-admin#ListResult"),
    },
    {
      id: "dsh-credentials-admin#credentialsAdmin/set",
      service: "credentialsAdmin",
      namespace: "credentialsAdmin",
      method: "set",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: codec("dsh-credentials-admin#SetPayload") },
      ],
      result: codec("dsh-credentials-admin#SetResult"),
    },
    {
      id: "dsh-credentials-admin#credentialsAdmin/unset",
      service: "credentialsAdmin",
      namespace: "credentialsAdmin",
      method: "unset",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: codec("dsh-credentials-admin#UnsetPayload") },
      ],
      result: codec("dsh-credentials-admin#UnsetResult"),
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/**
 * 业务失败一律 **抛** RemoteError，绝不自己包 `{ ok, value }` 信封。
 *
 * 教训（2026-09-22）：Typert 的 RPC 层已经替调用方包了 `{ ok, value }`。host 再包
 * 一层同形信封，客户端 `result.value` 拿到的是信封而不是数据 —— 结果列表恒为
 * "共 0 条"，且界面上不报错（因为 RPC 层认为是成功的）。官方
 * `dsh-api-settings-controller` 的 credentialsController 就是直接返回数据 +
 * throw RemoteError，照它写。
 */
function reject(code, error) {
  return new RemoteError(code, error instanceof Error ? error.message : String(error), {});
}

/**
 * Remote service 实现：管理 `.credentials.yaml` 的 refs 段。
 * 方法签名与 client 的 CONTRIBUTION 一一对应。
 */
class CredentialsAdminService extends TypertRemoteService {
  constructor(ctx, options) {
    super(ctx, "credentialsAdmin");
    this.filename = options.filename;
    this.lockWaitMs = options.lockWaitMs;
  }

  /** 列出 refs 段：只有名字与"是否已配置"，**没有值**。 */
  async list() {
    try {
      const text = await readFile(this.filename, "utf8");
      let updatedAt;
      try {
        updatedAt = (await stat(this.filename)).mtime.toISOString();
      } catch {
        updatedAt = undefined;
      }
      return { refs: listRefs(text), file: this.filename, updatedAt };
    } catch (error) {
      // 文件还不存在 = 空凭据库，不是错误。
      if (error?.code === "ENOENT") return { refs: [], file: this.filename };
      throw reject("read-failed", error);
    }
  }

  /** 新增或覆盖一条 ref。值只进不出，日志只记名字。 */
  async set(payload) {
    const refName = typeof payload?.name === "string" ? payload.name.trim() : "";
    const value = typeof payload?.value === "string" ? payload.value : "";
    if (!REF_NAME.test(refName)) {
      throw reject("bad-name", `凭据名只能用字母、数字、下划线，且不能以数字开头（收到 ${JSON.stringify(payload?.name ?? null)}）`);
    }
    if (value.length === 0) {
      throw reject("empty-value", "值为空：空值在 dsh 里等于不存在，请改用删除");
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw reject("too-long", `值过长（${value.length} 字符 > 上限 ${MAX_VALUE_LENGTH}）`);
    }
    try {
      const { replaced } = await this.mutateRefs((text) => setRef(text, refName, value));
      return { name: refName, replaced };
    } catch (error) {
      throw reject("write-failed", error);
    }
  }

  /** 删除一条 ref。（方法名必须是 unset：client 侧 RemoteNamespaceService 原型上已有 remove()，同名会被 API gateway 拒绝） */
  async unset(payload) {
    const refName = typeof payload?.name === "string" ? payload.name.trim() : "";
    if (!REF_NAME.test(refName)) {
      throw reject("bad-name", `凭据名只能用字母、数字、下划线，且不能以数字开头（收到 ${JSON.stringify(payload?.name ?? null)}）`);
    }
    try {
      const { removed } = await this.mutateRefs((text) => removeRef(text, refName));
      return { name: refName, removed };
    } catch (error) {
      throw reject("write-failed", error);
    }
  }

  /**
   * 读-改-写一次，全程持有 dsh 的写锁，落盘前用官方解析器自校验。
   * 顺序刻意如此：先校验文本再写，校验不过就抛错，磁盘保持原样。
   *
   * ⚠️ 这个方法**必须是普通方法，绝不能改成 `#私有方法`**（2026-09-22 踩的坑）：
   * Cordis 的 `Service` 基类把实例包成了 Proxy
   * （`cordis/lib/index.js`：`const self = new Proxy(this, ReflectService.handler)`），
   * 而私有方法/字段带 **brand check** —— 经 Proxy 调用时 `this` 不是"真实例"，
   * 直接抛 `Receiver must be an instance of class CredentialsAdminService`。
   * 普通属性读取不受影响（Proxy 照常转发），所以 `list()` 一路正常，
   * 只有经由这里的 `set`/`unset` 会挂。官方 `dsh-api-settings-controller` 同样
   * 一个 `#` 私有成员都不用，就是这个原因。
   */
  async mutateRefs(transform) {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    return withFileLock(
      this.filename,
      async () => {
        const text = await readFile(this.filename, "utf8");
        const result = transform(text);
        // dsh 的解析器必须原样接受新文本：它拒绝未知顶层键、坏名字、坏类型。
        parseCredentialsDocument(result.text, this.filename);
        await writeFileAtomic(this.filename, result.text, { mode: 0o600, dirMode: 0o700 });
        this.ctx.logger?.info?.("dsh-credentials-admin: refs 已更新");
        return result;
      },
      { waitMs: this.lockWaitMs },
    );
  }
}

export function apply(ctx, config) {
  const filename = config?.filename ?? defaultFilename();
  const lockWaitMs = config?.lockWaitMs ?? 5000;
  new CredentialsAdminService(ctx, { filename, lockWaitMs });
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-credentials-admin: typert manifest");
  ctx.logger?.info?.(`dsh-credentials-admin: 凭据管理已挂载 → ${filename}`);
}
