/**
 * generate-thumbs.mjs — Harness 创意工坊 封面图生成器
 * 读取 mock-data/workshop_items.json，为每个条目生成 640x360 的 SVG 封面到 thumbs/。
 * 风格：深色渐变底 + 网格纹理 + 光晕圆 + 居中标题（Steam 创意工坊封面质感）。
 * 纯 Node 标准库实现，无第三方依赖。用法：node scripts/generate-thumbs.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DATA = JSON.parse(readFileSync(join(ROOT, 'mock-data', 'workshop_items.json'), 'utf8'))
const THUMBS = join(ROOT, 'thumbs')
mkdirSync(THUMBS, { recursive: true })

const W = 640
const H = 360

/** 由 id 派生稳定的色相，保证同一插件每次生成的封面一致 */
function hueOf(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

/** 按字数折行，中文每行约 12 字，最多两行 */
function wrapLines(title, maxLen = 12, maxLines = 2) {
  const chars = [...title]
  const lines = []
  while (chars.length > 0 && lines.length < maxLines) {
    lines.push(chars.splice(0, maxLen).join(''))
  }
  if (chars.length > 0) lines[lines.length - 1] += '…'
  return lines
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function makeSvg(id, title, hue) {
  const h1 = hue
  const h2 = (hue + 40) % 360
  const lines = wrapLines(title)
  const tspans = lines
    .map((line, i) => {
      const y = 175 + i * 52
      return `      <tspan x="320" y="${y}">${esc(line)}</tspan>`
    })
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${h1}, 55%, 26%)"/>
      <stop offset="55%" stop-color="hsl(${h2}, 60%, 15%)"/>
      <stop offset="100%" stop-color="hsl(${h2}, 65%, 8%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="72%" cy="22%" r="55%">
      <stop offset="0%" stop-color="hsl(${h1}, 90%, 62%)" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="hsl(${h1}, 90%, 62%)" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
      <path d="M 44 0 L 0 0 0 44" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#grid)"/>
  <circle cx="500" cy="70" r="230" fill="url(#glow)"/>
  <circle cx="92" cy="300" r="150" fill="hsl(${h1}, 70%, 45%)" opacity="0.22"/>
  <circle cx="585" cy="310" r="90" fill="hsl(${h2}, 75%, 55%)" opacity="0.18"/>
  <g transform="rotate(-14 320 180)" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="26">
    <rect x="150" y="120" width="170" height="170" rx="18"/>
    <rect x="120" y="150" width="170" height="170" rx="18" opacity="0.6"/>
  </g>
  <text x="320" y="150" text-anchor="middle" font-family="'Motiva Sans','Segoe UI','Microsoft YaHei',sans-serif" font-size="34" font-weight="700" fill="#ffffff" letter-spacing="2">
${tspans}
  </text>
  <text x="20" y="342" font-family="'Motiva Sans','Segoe UI','Microsoft YaHei',sans-serif" font-size="15" font-weight="600" fill="rgba(255,255,255,0.55)" letter-spacing="3">HARNESS 创意工坊</text>
  <text x="620" y="342" text-anchor="end" font-family="'Motiva Sans','Segoe UI','Microsoft YaHei',sans-serif" font-size="13" fill="rgba(255,255,255,0.40)">${esc(id)}</text>
</svg>
`
}

let count = 0
for (const item of DATA.items) {
  const hue = hueOf(item.id)
  writeFileSync(join(THUMBS, `${item.id}.svg`), makeSvg(item.id, item.title, hue), 'utf8')
  count++
}
// 插件自身封面（plugin.manifest.json 引用）
writeFileSync(join(THUMBS, 'harness-workshop.svg'), makeSvg('harness-workshop', 'Harness 创意工坊', hueOf('harness-workshop')), 'utf8')
count++

console.log(`✓ 已生成 ${count} 张封面到 thumbs/`)
