/**
 * build-dsh-bundle.mjs — 组装 Harness 创意工坊的 DSH 客户端插件 bundle。
 *
 * 产物：lib/client.js（window.__ModuleLoader__.load 格式，供 dsh 服务端
 * 通过 /plugins/harness-workshop/client.js 下发到浏览器）。
 *
 * 组装内容：
 *   1. client/plugin.js（槽位注册 + React 外壳）—— 替换 __HW_SRCDOC__ / __HW_OVERLAY_CSS__
 *   2. index.html —— 内联 css/workshop.css、js/data.js、js/workshop.js，
 *      缩略图路径改写为 data URI，生成自包含 iframe srcdoc 文档
 * 用法：node scripts/build-dsh-bundle.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/* ---------- 1. 组装 iframe srcdoc 文档 ---------- */
let doc = read('index.html')
const css = read('css/workshop.css')

// 缩略图 → data URI（iframe 内相对路径无法解析）
const thumbsDir = join(ROOT, 'thumbs')
const thumbURIs = {}
for (const file of readdirSync(thumbsDir)) {
  if (!file.endsWith('.svg')) continue
  thumbURIs[file] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(readFileSync(join(thumbsDir, file), 'utf8'))
}
let dataJs = read('js/data.js')
dataJs = dataJs.replace(/thumbs\/[\w.-]+\.svg/g, (m) => thumbURIs[m.split('/')[1]] ?? m)
const appJs = read('js/workshop.js')

doc = doc
  .replace('<link rel="stylesheet" href="css/workshop.css">', `<style>\n${css}\n</style>`)
  .replace('<script src="js/data.js"></script>', `<script>\n${dataJs}\n</script>`)
  .replace('<script src="js/workshop.js"></script>', `<script>\n${appJs}\n</script>`)

/* ---------- 2. 外壳包裹样式 ---------- */
const overlayCss = `
.hw-overlay{position:fixed;inset:0;z-index:2147483000;background:#1b2838;pointer-events:auto;display:flex;flex-direction:column;animation:hw-fade-in .18s ease-out}
@keyframes hw-fade-in{from{opacity:0}to{opacity:1}}
.hw-frame{flex:1;width:100%;height:100%;border:0;display:block}
.hw-close{position:absolute;top:10px;right:14px;z-index:5;display:inline-flex;align-items:center;gap:6px;padding:7px 14px;font-size:12px;font-weight:600;color:#c6d4df;background:rgba(0,0,0,.45);border:1px solid rgba(102,192,244,.4);border-radius:3px;cursor:pointer;font-family:inherit;transition:all .15s}
.hw-close:hover{color:#fff;background:rgba(0,0,0,.65);border-color:#66c0f4}
.hw-action{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;font-size:12px;color:#c6d4df;background:none;border:none;border-radius:6px;cursor:pointer;font-family:inherit;transition:background .15s,color .15s;white-space:nowrap}
.hw-action:hover{background:rgba(102,192,244,.1);color:#fff}
.hw-action-open{color:#66c0f4}
.hw-action-label{font-size:12px;line-height:1}
`

/* ---------- 3. 组装 bundle ---------- */
let body = read('client/plugin.js')
body = body
  .replaceAll('__HW_SRCDOC__', JSON.stringify(doc))
  .replaceAll('__HW_OVERLAY_CSS__', JSON.stringify(overlayCss))

const bundle = `window.__ModuleLoader__.load({
	id: "harness-workshop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	}
});
`

mkdirSync(join(ROOT, 'lib'), { recursive: true })
writeFileSync(join(ROOT, 'lib', 'client.js'), bundle, 'utf8')

console.log(`✓ 已生成 lib/client.js（${(bundle.length / 1024).toFixed(1)} KB，srcdoc ${(doc.length / 1024).toFixed(1)} KB）`)
