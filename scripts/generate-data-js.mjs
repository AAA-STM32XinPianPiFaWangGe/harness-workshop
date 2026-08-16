/**
 * generate-data-js.mjs — 从 mock-data/workshop_items.json 生成 js/data.js（内嵌数据）。
 * 用途：双击 index.html（file:// 协议）离线打开时也能正常展示；HTTP 环境下页面会优先 fetch 数据文件。
 * 用法：node scripts/generate-data-js.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DATA = JSON.parse(readFileSync(join(ROOT, 'mock-data', 'workshop_items.json'), 'utf8'))

const out = `/* 自动生成：由 scripts/generate-data-js.mjs 从 mock-data/workshop_items.json 生成，请勿手动编辑。 */
window.WORKSHOP_DATA = ${JSON.stringify(DATA, null, 2)}
`
writeFileSync(join(ROOT, 'js', 'data.js'), out, 'utf8')
console.log(`✓ 已生成 js/data.js（${DATA.items.length} 个条目）`)
