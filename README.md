# dsh-credentials-admin — 凭据管理设置页插件

在 dsh Web 的 **Settings → 凭据管理** 分区里，管理 `$DSH_HOME/.credentials.yaml` 的 `refs:` 段长期凭据：列出、新增、覆盖、删除。

一句话设计原则：**值只进不出。** 界面能写新值，但永远不会显示、也不能取回任何已配置的值 —— 连值的长度都不给。这是设计，不是遗漏。

## dsh 版本兼容性

**要求 dsh ≥ 0.1.7-rc.1**（已在 0.1.7-rc.1 实测通过）。

- **Typert strict codec 必须带 `create()` 工厂**（2026-09-24）：0.1.7 起**客户端** typert registry 对 strict codec 同样严格校验（`dsh-typert-registry/lib/client.js` 要求 `codec.create` 是函数），缺失则打开设置卡片即报
  `typert: <id> result strict codec has no create() factory`。`client.js` 与 `index.js` 两处 codec 均已补 `create()`（服务端 gateway 走 `codec.create().parse(v)`）。

## 它做什么

| 能做 | 不能做（有意为之） |
| --- | --- |
| 列出 `refs:` 里所有凭据名 + 是否已配置 | 显示 / 复制 / 下载已配置的值 |
| 新增一条（名字 + 值） | 改 `records:` 段（浏览器会话 secret、Models 页的 API key） |
| 覆盖已有的值 | 改 `env` / `.env` 分层的凭据 |
| 删除一条 | 重命名（换名 = 新增 + 删旧，两步） |

改完**立即生效**：dsh 的 credentials provider 监听该文件，引用这些名字的脚本下次读取就能拿到新值，**不用重启**。

## 架构

两层，零 dsh 本体改动：

```
浏览器 (client.js)                          host (index.js)
Settings → 凭据管理  ──── Typert RPC ────▶  credentialsAdmin（TypertRemoteService）
   list / set / unset                          读-改-写 refs 段（行级编辑）
                                               dsh-atomic-write：文件锁 + 原子写
                                               credentials-local 解析器：写前自校验
```

**为什么自己写盘**：官方把 `refs:` 定义为**只读缝** —— `CredentialRef` 只做 `env → managed store → .env` 分层解析，唯一的官方写路径 `modifyRecord` 只管 `records:`。管理 `refs:` 属于扩展能力，所以自建（共用锁 + 写前自校验 + 只碰 `refs:` 段），全程不修改 dsh 本体。

## 三条硬纪律

1. **永不回显已配置的值。** `list` 只返回 `{ name, configured }`；服务端**不存在**任何"读单个 ref 明文"的方法，所以浏览器端就算被改也拿不到旧值。日志只记名字，绝不记值。
2. **只动 `refs:` 段。** 行级编辑，`records:` 段一字不改。写完立刻用 dsh 官方的 `parseCredentialsDocument` 自校验 —— 解析器不接受就整体放弃，**绝不落盘半成品**。
3. **与 dsh 共用同一把写锁。** `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 锁的是 `<file>.lock`（`wx` 创建），与 credentials provider 完全一致，所以"我写 refs"与"它写 records"不会互相覆盖。

## 目录

```
dsh-credentials-admin/
├── index.js             # host：credentialsAdmin remote service + refs 行级编辑纯函数
├── client.js            # 浏览器 bundle：Settings → 凭据管理 分区
├── scripts/selftest.mjs # 自测（只读真实文件做兼容性校验，不打印值）
├── cordis.patch.yml     # bundle patch（插入 host 插件行）
└── package.json
```

## 挂载

在 dsh profile（如 `$DSH_HOME/profiles/web/package.json`）里加依赖并登记 bundle：

```json
{
  "dependencies": {
    "dsh-credentials-admin": "link:/path/to/dsh-credentials-admin"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-credentials-admin"]
    }
  }
}
```

生效方式：**client 半**由 dsh web 现场从磁盘读取并经 `/plugins/??…` 组合路由下发，改完刷新页面即生效；**host 半**改动需要重启主实例。

## 配置

`cordis.patch.yml` 插入的插件行接受两个可选项，默认值通常够用：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `filename` | `$DSH_HOME/.credentials.yaml` | 托管凭据文档路径；`DSH_HOME` 未设置时用 `~/.dsh` |
| `lockWaitMs` | `5000` | 等待写锁的上限（dsh 侧同锁默认 2s，这里放宽以容忍并发窗口） |

输入约束：

- 凭据名匹配 `^[A-Za-z_][A-Za-z0-9_]*$` —— POSIX 名，不能以数字开头
- 值长度上限 **8192** 字符（挡住"把整个文件内容误粘贴进值框"这类事故）
- **空值 = 不存在**：在 dsh 里空值与缺失等价，所以要清空请用**删除**，不要保存空值

## RPC 接口

命名空间 `credentialsAdmin`，三个方法：

| 方法 | 参数 | 成功返回 |
| --- | --- | --- |
| `list` | — | `{ refs: [{ name, configured }], file, updatedAt }`（文件不存在 → `refs: []`，不算错误） |
| `set` | `{ name, value }` | `{ name, replaced }` |
| `unset` | `{ name }` | `{ name, removed }` |

失败**一律 `throw RemoteError(code, message)`**，错误码：`read-failed` / `bad-name` / `empty-value` / `too-long` / `write-failed`。

> ⚠️ **不要自己包 `{ ok, value }` 信封。** Typert 的 RPC 层已经替调用方包了一层；host 再包一层，客户端 `result.value` 拿到的是信封而不是数据 —— 症状是列表恒显示「共 0 条凭据」**且不报错**（RPC 层认为调用成功）。官方 `dsh-api-settings-controller` 的 `credentialsController` 就是"直接返回业务数据 + throw RemoteError"，照它写。

## 自测

```bash
node scripts/selftest.mjs
```

31 项断言：行级编辑纯函数（增 / 改 / 删 / 转义 / 边界）、与 dsh 官方解析器的兼容性、结构异常时的拒绝行为。**只读**真实凭据文件用于兼容性校验（内容不打印、不写入），所有写入都在内存文本上完成。

## 踩过的坑

- **方法名不能用 `remove`**：client 侧 `RemoteNamespaceService` 原型上已有 `remove()`，同名会被 API gateway 以
  `client api: method "credentialsAdmin/remove" conflicts with its namespace service` 拒绝，整个分区挂不起来。已改名 `unset`。
- **不要自包 RPC 信封**：见上方 RPC 接口的警告。这个坑的隐蔽之处在于它**不报错** —— 修完命名冲突后，页面能挂载了，却显示「共 0 条」，而 RPC 层一切正常。

## 限制

- 只管 `refs:` 段；`records:` 段、`env`、`.env` 层不在此处管理。
- 不支持重命名（请新增 + 删旧）。
- 无审计日志：文件里不记录"谁在何时改了哪个名字"，进程日志也只记"refs 已更新"。
