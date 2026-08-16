/**
 * test-bundle.mjs — DSH 客户端插件 bundle 集成测试（jsdom + 真实 React）
 * 验证：
 *   1. bundle 以 __ModuleLoader__.load 格式加载，exports 形态正确（apply / inject）
 *   2. apply 注册 sidebar.footer.action 与 shell.overlay 两个槽位
 *   3. WorkshopAction 渲染出「创意工坊」入口按钮；点击打开覆盖层
 *   4. WorkshopOverlay 渲染 iframe（srcdoc 内含完整独立创意工坊页面）；Esc / 关闭按钮可退出
 *   5. 渲染全程无 React key 相关控制台警告（回归防线）
 * 前置：已运行 scripts/build-dsh-bundle.mjs 生成 lib/client.js
 * React 解析顺序：环境变量 DSH_PROFILE_NODE_MODULES → 本机 DSH profile 默认路径 → 工作区 node_modules。
 * 用法：node scripts/test-bundle.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name} ${extra}`) }
}

// React 运行在 Node realm，其 console.error 走进程级 console，
// 需在渲染前直接拦截以捕获 key 警告（回归防线）
const reactWarnings = []
const origConsoleError = console.error
console.error = (...args) => {
  reactWarnings.push(args.map(String).join(' '))
  origConsoleError(...args)
}

function resolveFromProfile(spec) {
  const candidates = [
    process.env.DSH_PROFILE_NODE_MODULES && process.env.DSH_PROFILE_NODE_MODULES.replace(/[\\/]+$/, '') + '/',
    homedir() + '/.dsh/profiles/node_modules/',                     // 默认 DSH home 的扁平回退目录
    fileURLToPath(new URL('../node_modules/', import.meta.url)),    // 工作区 node_modules 兜底
  ].filter(Boolean)
  for (const base of candidates) {
    try { return createRequire(base)(spec) } catch { /* 尝试下一个候选 */ }
  }
  throw new Error(`无法解析 ${spec}：请设置 DSH_PROFILE_NODE_MODULES 指向 DSH profile 的 node_modules`)
}

const React = resolveFromProfile('react')
const JSXR = resolveFromProfile('react/jsx-runtime')
const ReactDOMClient = resolveFromProfile('react-dom/client')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:3080/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document

const bundleSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const loaded = {}
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    // 与真实 loader 一致：factory(require) 的返回值即模块导出
    const exports = factory((spec) => {
      if (spec === 'react') return React
      if (spec === 'react/jsx-runtime') return JSXR
      throw new Error(`bundle required unexpected external: ${spec}`)
    })
    loaded[id] = exports
  },
}

console.log('== 1. Bundle 加载与导出形态 ==')
// 执行 bundle（其内部调用 window.__ModuleLoader__.load）
new Function(bundleSrc)()
check('插件 id = harness-workshop', loaded['harness-workshop'] !== undefined)
const plugin = loaded['harness-workshop']
check('exports.inject = ["slots"]', JSON.stringify(plugin.inject) === JSON.stringify(['slots']))
check('exports.apply 是函数', typeof plugin.apply === 'function')

console.log('== 2. 槽位注册 ==')
const injections = []
const registrations = []
const fakeCtx = {
  slots: {
    inject(key, thunk) { injections.push([key, thunk]) },
    register(opts, comp) { registrations.push({ opts, comp }); return () => {} },
  },
}
plugin.apply(fakeCtx)
check('注入 2 个槽位', injections.length === 2, `实际 ${injections.length}`)
check('注入 sidebar.footer.action', injections.some(([k]) => k === 'sidebar.footer.action'))
check('注入 shell.overlay', injections.some(([k]) => k === 'shell.overlay'))
for (const [, thunk] of injections) thunk()
check('注册 2 个条目', registrations.length === 2)
const actionReg = registrations.find((r) => r.opts.name === 'sidebar.footer.action')
const overlayReg = registrations.find((r) => r.opts.name === 'shell.overlay')
check('action: id=harness-workshop', actionReg?.opts.id === 'harness-workshop')
check('overlay: id=harness-workshop-overlay', overlayReg?.opts.id === 'harness-workshop-overlay')
check('两个组件都是函数', typeof actionReg?.comp === 'function' && typeof overlayReg?.comp === 'function')

console.log('== 3. React 渲染（真实 react 18 + jsdom） ==')
const rootEl = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(rootEl)
const Wrap = () =>
  JSXR.jsxs(React.Fragment, {
    children: [
      JSXR.jsx(actionReg.comp, { wide: true }, "action"),
      JSXR.jsx(overlayReg.comp, {}, "overlay"),
    ],
  })
root.render(JSXR.jsx(Wrap, {}))
await new Promise((r) => setTimeout(r, 80))

const actionBtn = rootEl.querySelector('button.hw-action')
check('入口按钮渲染', actionBtn !== null)
check('入口按钮含「创意工坊」文案', actionBtn?.textContent.includes('创意工坊'))
check('初始覆盖层关闭（无 iframe）', rootEl.querySelector('iframe.hw-frame') === null)

actionBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 80))
const frame = rootEl.querySelector('iframe.hw-frame')
check('点击后覆盖层打开', frame !== null)
const srcDoc = frame?.getAttribute('srcdoc') || ''
check('srcdoc 含独立工坊页面骨架', srcDoc.includes('class="workshop"') && srcDoc.includes('id="item-grid"'))
check('srcdoc 内嵌数据', srcDoc.includes('window.WORKSHOP_DATA') && srcDoc.includes('"items"'))
check('srcdoc 内嵌样式', srcDoc.includes('.item-card'))
check('srcdoc 缩略图为 data URI', srcDoc.includes('data:image/svg+xml'))
check('关闭按钮渲染', rootEl.querySelector('button.hw-close') !== null)

// 关闭按钮
rootEl.querySelector('button.hw-close').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 80))
check('关闭按钮可退出覆盖层', rootEl.querySelector('iframe.hw-frame') === null)

// Esc 退出
actionBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 80))
dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await new Promise((r) => setTimeout(r, 80))
check('Esc 可退出覆盖层', rootEl.querySelector('iframe.hw-frame') === null)

// 窄栏（rail）模式入口按钮仍渲染
root.unmount()
const root2 = ReactDOMClient.createRoot(rootEl)
root2.render(JSXR.jsx(actionReg.comp, { wide: false }))
await new Promise((r) => setTimeout(r, 60))
check('rail 模式按钮渲染（无文字）', rootEl.querySelector('button.hw-action') !== null &&
  !rootEl.querySelector('button.hw-action')?.textContent.includes('创意工坊'))
root2.unmount()

console.log('== 4. 控制台警告检查 ==')
console.error = origConsoleError
const keyWarnings = reactWarnings.filter((m) => m.includes('"key" prop') || m.includes('unique "key"'))
check('无 React key 相关警告', keyWarnings.length === 0, keyWarnings.slice(0, 2).join(' | '))
const otherWarnings = reactWarnings.filter((m) => !m.includes('"key" prop') && !m.includes('unique "key"'))
if (otherWarnings.length > 0) console.log(`    （另有 ${otherWarnings.length} 条其他 React 警告：${otherWarnings.slice(0, 1).join(' | ').slice(0, 120)}）`)

console.log(failures === 0 ? '\n✔ 客户端插件集成测试全部通过' : `\n✘ ${failures} 项测试失败`)
process.exit(failures === 0 ? 0 : 1)
