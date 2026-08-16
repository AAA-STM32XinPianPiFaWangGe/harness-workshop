/* ==========================================================================
 * Harness 创意工坊 — DSH 客户端插件核心（由 scripts/build-dsh-bundle.mjs 组装）
 *
 * 本文件以 DSH 客户端 bundle 的 factory 体形式编写：
 *   - require() 解析自浏览器端冻结模块表（react / react/jsx-runtime /
 *     @deepseek-ai/dsh-client-ui-slots 等）
 *   - 注册两个槽位入口：
 *       1) sidebar.footer.action —— 侧边栏底部「创意工坊」入口按钮
 *       2) shell.overlay        —— 全屏创意工坊界面（iframe 承载完整独立页面，
 *                                   样式/脚本与 DSH 外壳完全隔离）
 *   - SRCDOC_PLACEHOLDER / OVERLAY_CSS_PLACEHOLDER 由构建脚本替换为实际内容
 * ========================================================================== */

/* ---------- 依赖（浏览器冻结模块表） ---------- */
const REACT = require("react")
const JSXR = require("react/jsx-runtime")

/* ---------- 共享打开状态（React 无状态外壳外的模块级 store） ---------- */
const hwListeners = new Set()
let hwOpen = false
const hwStore = {
  subscribe(fn) { hwListeners.add(fn); return () => { hwListeners.delete(fn) } },
  getSnapshot() { return hwOpen },
  toggle() { hwOpen = !hwOpen; for (const fn of [...hwListeners]) fn() },
  close() { if (!hwOpen) return; hwOpen = false; for (const fn of [...hwListeners]) fn() },
}

/* ---------- 由构建脚本注入：完整独立创意工坊页面（iframe srcdoc） ---------- */
const WORKSHOP_SRCDOC = __HW_SRCDOC__

/* ---------- 包裹样式注入（沿用 DSH 标准 data-plugin style 机制） ---------- */
const HW_CSS = __HW_OVERLAY_CSS__
const HW_CSS_TAG = "harness-workshop/overlay.css"
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(HW_CSS_TAG) + "]") === null) {
  const tag = document.createElement("style")
  tag.dataset.plugin = "harness-workshop"
  tag.dataset.pluginCss = HW_CSS_TAG
  tag.textContent = HW_CSS
  document.head.appendChild(tag)
}

/* ---------- 侧边栏底部动作：创意工坊入口 ---------- */
function WorkshopAction(props) {
  const open = REACT.useSyncExternalStore(hwStore.subscribe, hwStore.getSnapshot)
  const wide = props != null && props.wide === true
  const icon = JSXR.jsx("svg", {
    viewBox: "0 0 32 32",
    width: wide ? 15 : 17,
    height: wide ? 15 : 17,
    "aria-hidden": true,
    children: JSXR.jsx("g", {
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      children: JSXR.jsxs("g", {
        children: [
          JSXR.jsx("path", { d: "M13 5h6l-1.4 6.5 4.2 2.6-2.6 3.8 1.2 6.9-5.2-2.5-5.2 2.5 1.2-6.9-2.6-3.8 4.2-2.6z" }, "p"),
          JSXR.jsx("circle", { cx: 16, cy: 16, r: 2.6 }, "c"),
        ],
      }),
    }),
  }, "icon")
  const label = wide
    ? JSXR.jsx("span", { className: "hw-action-label", children: "创意工坊" }, "label")
    : null
  return JSXR.jsx("button", {
    type: "button",
    className: "hw-action" + (open ? " hw-action-open" : ""),
    onClick: hwStore.toggle,
    title: "打开 Harness 创意工坊",
    "aria-label": "打开 Harness 创意工坊",
    children: [icon, label],
  })
}

/* ---------- 全屏覆盖层：创意工坊 ---------- */
function WorkshopOverlay() {
  const open = REACT.useSyncExternalStore(hwStore.subscribe, hwStore.getSnapshot)
  const iframeRef = REACT.useRef(null)
  REACT.useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === "Escape") hwStore.close() }
    window.addEventListener("keydown", onKey)
    return () => { window.removeEventListener("keydown", onKey) }
  }, [open])

  // iframe（工坊页面）→ 宿主桥：把「订阅→真实安装 / 卸载」请求转发到 host API，
  // 再把结果回传给 iframe（requestId 关联）。
  REACT.useEffect(() => {
    if (!open) return undefined
    const onMessage = (e) => {
      const data = e.data
      if (!data || typeof data !== "object") return
      if (e.source !== iframeRef.current?.contentWindow) return
      const post = (res) => {
        iframeRef.current?.contentWindow?.postMessage({
          type: "hw:install-result",
          requestId: data.requestId,
          ok: !!res.ok,
          message: res.message || "",
        }, "*")
      }
      if (data.type === "hw:prompt-agent") {
        promptAgentInstall(data.payload || {})
          .then(post)
          .catch((err) => post({ ok: false, message: String((err && err.message) || err) }))
        return
      }
      if (data.type !== "hw:install" && data.type !== "hw:uninstall") return
      const ep = data.type === "hw:install"
        ? "/api/harness-workshop/install"
        : "/api/harness-workshop/uninstall"
      fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data.payload || {}),
      })
        .then((r) => r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` })))
        .then(post)
        .catch((err) => post({ ok: false, message: String((err && err.message) || err) }))
    }
    window.addEventListener("message", onMessage)
    return () => { window.removeEventListener("message", onMessage) }
  }, [open])

  if (!open) return null
  return JSXR.jsxs("div", {
    className: "hw-overlay",
    children: [
      JSXR.jsx("iframe", {
        ref: iframeRef,
        className: "hw-frame",
        title: "Harness 创意工坊",
        srcDoc: WORKSHOP_SRCDOC,
      }),
      JSXR.jsx("button", {
        type: "button",
        className: "hw-close",
        onClick: hwStore.close,
        title: "退出创意工坊（Esc）",
        children: "✕ 退出创意工坊",
      }),
    ],
  })
}

/* ---------- 插件注册 ---------- */
let hwCtx = null
function apply(ctx) {
  hwCtx = ctx
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    { name: "sidebar.footer.action", id: "harness-workshop", order: 20 },
    WorkshopAction,
  ))
  ctx.slots.inject("shell.overlay", () => ctx.slots.register(
    { name: "shell.overlay", id: "harness-workshop-overlay", order: 999 },
    WorkshopOverlay,
  ))
}

/** 把「订阅 → 让 Harness agent 安装」请求发给当前会话（用户已放开权限）。 */
function promptAgentInstall(payload) {
  const sessions = hwCtx && hwCtx.sessions
  const list = sessions && sessions.list && sessions.list.getSnapshot
    ? sessions.list.getSnapshot()
    : null
  const sessionId = list && list.current
  if (!sessionId) return { ok: false, message: "当前没有打开的会话，请先打开一个会话再订阅" }
  const binding = sessions.binding(sessionId)
  if (!binding || !binding.session || typeof binding.session.prompt !== "function") {
    return { ok: false, message: "无法访问会话（binding 未就绪），请稍后再试" }
  }
  const url = (payload && payload.url) || ""
  const text = [
    "【创意工坊 · 插件安装请求】",
    `用户通过创意工坊订阅了插件「${(payload && payload.title) || ""}」${payload && payload.version ? "（v" + payload.version + "）" : ""}。`,
    url ? `安装源：${url}` : "",
    payload && payload.description ? `简介：${payload.description}` : "",
    "",
    "请代为完成真实安装：",
    "1) 获取源码/安装包（若本机 GitHub 被 hosts 屏蔽，可参考插件仓库内 scripts/fetch-github.mjs 的 hosts 绕过方式，或用 git clone）；",
    "2) 校验它是否是有效的 DSH 插件（package.json 声明 dsh.client 或 dsh.bundle，或含 plugin.manifest.json）；",
    "3) 若有效：装进当前 web profile（$DSH_HOME/profiles/web，未设置 DSH_HOME 时为 ~/.dsh/profiles/web）：package.json 的 dependencies 加 link 依赖、cordis.patch.yml 加 insert 行、pnpm install，完成后提示用户刷新页面生效；",
    "4) 若不是有效 DSH 插件或无法安装，直接说明原因即可，不要强行安装。",
    "用户已放开权限，可自行执行。",
  ].filter(Boolean).join("\n")
  return binding.session.prompt([{ type: "text", text }], "queue")
    .then((res) => {
      const ok = !!res && !!res.accepted
      return { ok, message: ok ? "已提交给 Harness 自动安装，进度请看对话" : "提交失败：" + JSON.stringify(res) }
    })
    .catch((err) => ({ ok: false, message: "提交失败：" + String((err && err.message) || err) }))
}

exports.inject = ["slots", "sessions"]
exports.apply = apply
