/**
 * dsh-credentials-admin — client 半部分（浏览器 bundle，Typert Remote 版）
 *
 * 在 dsh 设置页注册一个 `settings.section` 分区：「凭据管理」。
 * 列出 `$DSH_HOME/.credentials.yaml` 里 `refs:` 段的凭据名，支持添加 / 修改 / 删除。
 *
 * **核心约束：已配置的值永不回显。** host 端的 list 只返回 `{ name, configured }`，
 * 不存在任何把明文送到浏览器的接口 —— 连"值长度"都不给。修改 = 覆盖，
 * 界面里没有"查看/复制现有值"这种东西，这是设计，不是遗漏。
 *
 * 浏览器可直接执行（`__ModuleLoader__.load`），React.createElement 手写。
 */
window.__ModuleLoader__.load({
  id: "dsh-credentials-admin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    // ── remote 贡献：声明 host remote service 的方法签名 ─────────────────────
    // client 边界只要求 parse()；服务端 MANIFEST 负责严格校验。
    const identity = (value) => value;
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });

    const CONTRIBUTION = {
      package: "dsh-credentials-admin",
      descriptors: [
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
    };

    // ── 样式 ────────────────────────────────────────────────────────────────
    const card = { display: "flex", flexDirection: "column", gap: 14 };
    const note = { fontSize: 12, lineHeight: 1.7, opacity: 0.72 };
    const rowGrid = {
      display: "grid",
      gridTemplateColumns: "1fr auto auto",
      alignItems: "center",
      gap: 10,
      padding: "7px 10px",
      borderBottom: "1px solid rgba(128,128,128,0.18)",
    };
    const head = { ...rowGrid, fontWeight: 600, fontSize: 12, opacity: 0.65, borderBottom: "1px solid rgba(128,128,128,0.35)" };
    const field = {
      padding: "6px 10px",
      borderRadius: 8,
      border: "1px solid rgba(128,128,128,0.4)",
      background: "transparent",
      color: "inherit",
      fontSize: 13,
      fontFamily: "inherit",
      minWidth: 0,
    };
    const button = (primary, disabled) => ({
      padding: "6px 14px",
      borderRadius: 8,
      border: primary ? "1px solid transparent" : "1px solid rgba(128,128,128,0.4)",
      background: primary ? "rgba(64,140,255,0.9)" : "transparent",
      color: primary ? "#fff" : "inherit",
      fontSize: 13,
      fontFamily: "inherit",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.5 : 1,
      whiteSpace: "nowrap",
    });
    const pill = (on) => ({
      fontSize: 12,
      padding: "2px 8px",
      borderRadius: 999,
      background: on ? "rgba(64,180,120,0.18)" : "rgba(128,128,128,0.16)",
      color: on ? "rgb(60,170,110)" : "inherit",
      opacity: on ? 1 : 0.7,
    });
    const banner = (kind) => ({
      padding: "7px 10px",
      borderRadius: 8,
      fontSize: 12,
      background: kind === "error" ? "rgba(220,80,80,0.14)" : "rgba(64,180,120,0.14)",
      color: kind === "error" ? "rgb(220,90,90)" : "rgb(60,170,110)",
    });

    /**
     * 新增表单 + 凭据列表。数据全部经 props（list/set/unset remote 调用）异步拉取。
     * 值一律 type=password，且没有任何回填逻辑 —— 服务端就没给过旧值。
     */
    function CredentialsSection(props) {
      const { list, set, unset } = props;
      const [rows, setRows] = React.useState([]);
      const [meta, setMeta] = React.useState(null);
      const [status, setStatus] = React.useState("loading");
      const [error, setError] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [newName, setNewName] = React.useState("");
      const [newValue, setNewValue] = React.useState("");
      const [editName, setEditName] = React.useState("");
      const [editValue, setEditValue] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [tick, setTick] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        setStatus("loading");
        list()
          .then((data) => {
            if (!alive) return;
            setRows(Array.isArray(data?.refs) ? data.refs : []);
            setMeta({ file: data?.file, updatedAt: data?.updatedAt });
            setStatus("ready");
          })
          .catch((e) => {
            if (!alive) return;
            setError(String(e?.message ?? e));
            setStatus("error");
          });
        return () => {
          alive = false;
        };
      }, [tick]);

      const run = async (fn, okMsg) => {
        setBusy(true);
        setError("");
        setNotice("");
        try {
          await fn();
          setNotice(okMsg);
          setTick((t) => t + 1);
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      const submitNew = () =>
        run(async () => {
          await set({ name: newName.trim(), value: newValue });
          setNewName("");
          setNewValue("");
        }, "已保存");

      const submitEdit = () =>
        run(async () => {
          await set({ name: editName, value: editValue });
          setEditName("");
          setEditValue("");
        }, "已更新");

      const drop = (name) => {
        if (typeof window !== "undefined" && !window.confirm(`删除凭据「${name}」？\n\n此操作不可撤销；引用它的脚本会立刻失效。`)) return;
        run(() => unset({ name }), "已删除");
      };

      const canAdd = newName.trim().length > 0 && newValue.length > 0 && !busy;

      const children = [
        S.jsx("div", {
          style: note,
          children: [
            "管理 ",
            S.jsx("code", { children: "$DSH_HOME/.credentials.yaml" }),
            " 的 ",
            S.jsx("code", { children: "refs:" }),
            " 段（长期凭据）。",
            S.jsx("br", {}),
            S.jsx("strong", { children: "已配置的值不会显示，也无法取回" }),
            " —— 只有覆盖或删除；空值等于不存在，所以「清空」请用删除。",
          ],
        }),
        error ? S.jsx("div", { style: banner("error"), children: error }) : null,
        notice ? S.jsx("div", { style: banner("ok"), children: notice }) : null,
        // ── 新增 ──────────────────────────────────────────────────────────
        S.jsxs("div", {
          style: { display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "center" },
          children: [
            S.jsx("input", {
              style: field,
              placeholder: "凭据名，如 MIKROTIK_PASS",
              value: newName,
              spellCheck: false,
              autoComplete: "off",
              onChange: (e) => setNewName(e.target.value),
            }),
            S.jsx("input", {
              style: field,
              placeholder: "值（不会回显）",
              type: "password",
              value: newValue,
              spellCheck: false,
              autoComplete: "new-password",
              onChange: (e) => setNewValue(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter" && canAdd) submitNew();
              },
            }),
            S.jsx("button", {
              style: button(true, !canAdd),
              disabled: !canAdd,
              onClick: submitNew,
              children: busy ? "处理中…" : "添加",
            }),
          ],
        }),
        // ── 列表 ──────────────────────────────────────────────────────────
        status === "ready"
          ? S.jsx("div", {
              style: note,
              children:
                `共 ${rows.length} 条凭据` +
                (meta?.updatedAt ? ` · 文件更新于 ${new Date(meta.updatedAt).toLocaleString()}` : "") +
                (meta?.file ? ` · ${meta.file}` : ""),
            })
          : null,
        status === "loading"
          ? S.jsx("div", { style: note, children: "读取中…" })
          : rows.length === 0
            ? S.jsx("div", { style: note, children: "refs 里还没有任何凭据。" })
            : S.jsxs("div", {
                children: [
                  S.jsxs("div", { style: head, children: [S.jsx("div", { children: "凭据名" }), S.jsx("div", { children: "状态" }), S.jsx("div", { children: "操作" })] }),
                  ...rows.map((row) =>
                    row.name === editName
                      ? S.jsxs(
                          "div",
                          {
                            key: row.name,
                            style: { ...rowGrid, gridTemplateColumns: "1fr 1fr auto auto" },
                            children: [
                              S.jsx("code", { style: { fontSize: 13 }, children: row.name }),
                              S.jsx("input", {
                                style: field,
                                placeholder: "新值",
                                type: "password",
                                value: editValue,
                                autoFocus: true,
                                autoComplete: "new-password",
                                onChange: (e) => setEditValue(e.target.value),
                                onKeyDown: (e) => {
                                  if (e.key === "Enter" && editValue.length > 0 && !busy) submitEdit();
                                  if (e.key === "Escape") {
                                    setEditName("");
                                    setEditValue("");
                                  }
                                },
                              }),
                              S.jsx("button", {
                                style: button(true, editValue.length === 0 || busy),
                                disabled: editValue.length === 0 || busy,
                                onClick: submitEdit,
                                children: "保存",
                              }),
                              S.jsx("button", {
                                style: button(false, busy),
                                disabled: busy,
                                onClick: () => {
                                  setEditName("");
                                  setEditValue("");
                                },
                                children: "取消",
                              }),
                            ],
                          },
                          row.name,
                        )
                      : S.jsxs(
                          "div",
                          {
                            key: row.name,
                            style: rowGrid,
                            children: [
                              S.jsx("code", { style: { fontSize: 13 }, children: row.name }),
                              S.jsx("span", { style: pill(row.configured), children: row.configured ? "已配置" : "空值" }),
                              S.jsxs("div", {
                                style: { display: "flex", gap: 8 },
                                children: [
                                  S.jsx("button", {
                                    style: button(false, busy),
                                    disabled: busy,
                                    onClick: () => {
                                      setEditName(row.name);
                                      setEditValue("");
                                      setNotice("");
                                      setError("");
                                    },
                                    children: "修改",
                                  }),
                                  S.jsx("button", {
                                    style: button(false, busy),
                                    disabled: busy,
                                    onClick: () => drop(row.name),
                                    children: "删除",
                                  }),
                                ],
                              }),
                            ],
                          },
                          row.name,
                        ),
                  ),
                ],
              }),
        S.jsx("div", {
          style: note,
          children: "改完立即生效：dsh 的 credentials provider 监听该文件，引用这些名字的脚本下次读取就能拿到新值，无需重启。",
        }),
      ];

      return S.jsxs("div", { style: card, children });
    }

    /** 需要 slots（注册设置项）+ remote（调用 host remote service）。 */
    const inject = ["slots", "remote"];

    /**
     * 解包 RPC 返回值。
     *
     * host 方法按官方 Typert 约定**直接返回业务数据**、失败时抛 RemoteError，
     * 而 RPC 层自己会再包一层 `{ ok, value }`。早期版本的 host 在业务层多包了
     * 一层同形信封 —— 于是这里拿到的 `result.value` 是 `{ ok, value }` 而不是数据，
     * `data.refs` 恒为 undefined，列表永远显示"共 0 条"。
     *
     * 兼容策略：有 `ok` 字段就当信封剥掉（且 ok=false 视为业务失败），
     * 没有就直接用。这样 host 改前改后都正确，不必与重启同步。
     */
    const unwrapValue = (method, value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value) || !("ok" in value)) return value;
      if (value.ok === false) {
        throw new Error(`credentialsAdmin.${method} 失败：${value?.error?.code ?? "?"}: ${value?.error?.message ?? "?"}`);
      }
      return value.value;
    };

    function apply(ctx) {
      // 挂载远程贡献，所有 remote 调用等待挂载完成。
      const mount = ctx.remote.$mount(CONTRIBUTION);
      const callRemote = async (method, ...args) => {
        await mount;
        const remote = ctx.get("remote.credentialsAdmin");
        if (remote === void 0) throw new Error("remote.credentialsAdmin 不可用");
        const result = await remote[method](...args);
        if (!result || !result.ok) {
          throw new Error(`credentialsAdmin.${method} 失败：${result?.error?.code ?? "?"}: ${result?.error?.message ?? "?"}`);
        }
        return unwrapValue(method, result.value);
      };

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "credentials",
            order: 60,
            label: () => "凭据管理",
            inject: () => ({
              list: () => callRemote("list"),
              set: (payload) => callRemote("set", payload),
              unset: (payload) => callRemote("unset", payload),
            }),
          },
          CredentialsSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
