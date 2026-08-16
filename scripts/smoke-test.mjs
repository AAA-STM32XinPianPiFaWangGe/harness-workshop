/**
 * smoke-test.mjs — Harness 创意工坊 DOM 冒烟测试（jsdom，无头）
 * 需要先运行 node scripts/serve.mjs 8357（HTTP 模式），并已 npm install jsdom。
 *
 * 数据驱动：所有与数据相关的期望值（卡片数、分类/搜索命中数、排序首位等）
 * 均从 mock-data/workshop_items.json 实时计算，新增/修改条目无需改动本测试；
 * 仅「分类树结构」等由代码定义的断言保持常量。
 *
 * 覆盖：网格渲染 / 统计条 / 分类树 / 标签过滤 / 排序切换（鼠标+键盘）/ 订阅持久化 /
 *       详情路由与焦点管理 / Esc 返回 / 评论提交 / 偏好持久化 / file:// 回退。
 * 用法：node scripts/smoke-test.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:8357/'
const DATA = JSON.parse(readFileSync(new URL('../mock-data/workshop_items.json', import.meta.url), 'utf8'))
const ITEMS = DATA.items
const DAY = 86400000
let failures = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (n) => Number(n || 0).toLocaleString('zh-CN')

/* ---- 与 js/workshop.js 保持一致的期望计算 ---- */

function popularityScore(item) {
  const W = { subscriber: 1.0, view: 0.02, rating: 180, ratingCount: 0.05 }
  const s = item.stats || {}
  const age = Date.now() - Number(item.update_time)
  let freshness = 0
  if (age <= 7 * DAY) freshness = 200
  else if (age <= 30 * DAY) freshness = 80
  else if (age <= 90 * DAY) freshness = 20
  return (s.subscribers || 0) * W.subscriber
    + (s.views || 0) * W.view
    + (s.rating || 0) * W.rating
    + (s.rating_count || 0) * W.ratingCount
    + freshness
}

function sortedBy(key) {
  const arr = [...ITEMS]
  switch (key) {
    case 'subscribers':
      return arr.sort((a, b) => (b.stats?.subscribers ?? 0) - (a.stats?.subscribers ?? 0))
    case 'views':
      return arr.sort((a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0))
    case 'updated':
      return arr.sort((a, b) => Number(b.update_time) - Number(a.update_time))
    case 'rating':
      return arr.sort((a, b) => {
        const d = (b.stats?.rating ?? 0) - (a.stats?.rating ?? 0)
        if (d !== 0) return d
        return (b.stats?.rating_count ?? 0) - (a.stats?.rating_count ?? 0)
      })
    default:
      return arr.sort((a, b) => popularityScore(b) - popularityScore(a))
  }
}

function searchMatches(item, q) {
  const hay = [item.title, item.author, item.description, ...(item.tags || [])]
    .filter(Boolean).join(' ').toLowerCase()
  return hay.includes(q.toLowerCase())
}

function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name} ${extra}`) }
}

async function load(url, opts = {}) {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(String(e.detail || e.message || e)))
  vc.on('error', (e) => errors.push(String(e)))
  const dom = await JSDOM.fromURL(url, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // jsdom 不内置 fetch / crypto.subtle：用 Node 实现补齐，
      // 让「HTTP 模式拉取数据文件」与「真实安装的 sha256 校验」可被真实测到。
      if (typeof window.fetch !== 'function') {
        Object.defineProperty(window, 'fetch', {
          value: (u, o) => fetch(new URL(String(u), window.location.href), o),
          configurable: true,
        })
      }
      if (!(window.crypto && window.crypto.subtle)) {
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true })
      }
    },
    ...opts,
  })
  await sleep(opts.waitMs ?? 900)
  return { dom, errors }
}

async function main() {
  console.log(`== 1. 浏览视图（HTTP 模式，fetch 数据文件，共 ${ITEMS.length} 条） ==`)
  // ?hw-demo-install=1 强制演示安装：测试不依赖真实 GitHub 下载
  const { dom, errors } = await load(BASE + '?hw-demo-install=1#/browse')
  const doc = dom.window.document
  check('无 JS 错误', errors.length === 0, JSON.stringify(errors.slice(0, 3)))

  let cards = doc.querySelectorAll('.item-card')
  check(`网格渲染 ${ITEMS.length} 张卡片`, cards.length === ITEMS.length, `实际 ${cards.length}`)
  check(`统计条-物品总数=${ITEMS.length}`, doc.querySelector('#stat-total')?.textContent === fmt(ITEMS.length))
  // 分类树结构由 CATEGORIES 常量（代码）定义：全部 + 4 组 + 8 叶子
  check('分类树渲染（全部+4组+8叶子=13 节点）', doc.querySelectorAll('.cat-node').length === 13)
  check('分类树子节点（主题等）', doc.querySelectorAll('.cat-children .cat-row').length === 8)
  const uniqueTags = new Set(ITEMS.flatMap((i) => i.tags || []))
  check(`标签过滤器渲染（${uniqueTags.size} 个唯一标签）`, doc.querySelectorAll('.tag-item').length === uniqueTags.size)
  check('最热门排序默认选中', doc.querySelector('#sort-label')?.textContent === '最热门')

  const popularFirst = sortedBy('popular')[0].title
  console.log(`    首张卡片（最热门）: ${popularFirst}`)
  check('最热门首卡与算法一致', cards[0]?.querySelector('.card-title')?.textContent === popularFirst)

  console.log('== 2. 排序切换（鼠标点击） ==')
  for (const [key, label] of [
    ['subscribers', '最多订阅'],
    ['updated', '最近更新'],
    ['rating', '最高评分'],
    ['views', '最多浏览'],
  ]) {
    const expectedFirst = sortedBy(key)[0].title
    const li = doc.querySelector(`.sort-menu li[data-sort="${key}"]`)
    li?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await sleep(120)
    const first = doc.querySelector('.item-card .card-title')?.textContent
    check(`${label} → 首个=${expectedFirst}`, first === expectedFirst, `实际 ${first}`)
  }

  console.log('== 3. 排序下拉键盘导航 ==')
  const trigger = doc.querySelector('#sort-trigger')
  trigger.focus()
  trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await sleep(120)
  check('键盘 ↓ 展开菜单', !doc.querySelector('#sort-menu').hidden)
  // 打开时活动项应从当前选中项开始（上一节鼠标最后选了「最多浏览」）
  check('打开时活动项为当前排序', doc.querySelector('.sort-menu li.active')?.dataset.sort === 'views',
    `实际 ${doc.querySelector('.sort-menu li.active')?.dataset.sort}`)
  trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  await sleep(80)
  check('Home 跳到第一项（最热门）', doc.querySelector('.sort-menu li.active')?.dataset.sort === 'popular')
  trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await sleep(80)
  check('↓ 移到第二项（最多订阅）', doc.querySelector('.sort-menu li.active')?.dataset.sort === 'subscribers')
  trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await sleep(120)
  const prefsAfterKeys = JSON.parse(dom.window.localStorage.getItem('harness_workshop_prefs') || '{}')
  const subFirst = sortedBy('subscribers')[0].title
  check('键盘选中后 prefs 写入 sort', prefsAfterKeys.sort === 'subscribers', JSON.stringify(prefsAfterKeys))
  check(`键盘选中生效（首个=${subFirst}）`, doc.querySelector('.item-card .card-title')?.textContent === subFirst)
  check('键盘选中后菜单关闭', doc.querySelector('#sort-menu').hidden)
  // 恢复默认排序
  doc.querySelector('.sort-menu li[data-sort="popular"]')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(120)

  console.log('== 4. 分类过滤 ==')
  const themeCount = ITEMS.filter((i) => (i.tags || []).includes('主题')).length
  const themeRow = doc.querySelector('.cat-row[data-cat="theme"]')
  themeRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(120)
  cards = doc.querySelectorAll('.item-card')
  check(`主题分类 → ${themeCount} 张卡片`, cards.length === themeCount, `实际 ${cards.length}`)
  check('标题联动', doc.querySelector('#content-title')?.textContent === '主题')
  const prefsAfterCat = JSON.parse(dom.window.localStorage.getItem('harness_workshop_prefs') || '{}')
  check('分类选择持久化 prefs.category', prefsAfterCat.category === 'theme', JSON.stringify(prefsAfterCat))
  const allRow = doc.querySelector('.cat-row[data-cat="all"]')
  allRow?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(120)

  console.log('== 5. 搜索 ==')
  const agentCount = ITEMS.filter((i) => searchMatches(i, 'Agent')).length
  const input = doc.querySelector('#search-input')
  input.value = 'Agent'
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(300)
  cards = doc.querySelectorAll('.item-card')
  check(`搜索 Agent → ${agentCount} 张卡片`, cards.length === agentCount, `实际 ${cards.length}`)
  input.value = ''
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(300)

  console.log('== 6. 订阅与自动安装 ==')
  const subBtn = doc.querySelector('.item-card .sub-btn')
  const subId = subBtn?.dataset.sub
  const before = dom.window.localStorage.getItem('harness_workshop_subscribed_list')
  subBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  const after = JSON.parse(dom.window.localStorage.getItem('harness_workshop_subscribed_list') || '[]')
  check('localStorage 写入订阅', before !== after && after.includes(subId), JSON.stringify(after))
  check('卡片出现订阅徽标', doc.querySelector('.item-card.subscribed .card-sub-badge') !== null)
  check('统计条-已订阅=1', doc.querySelector('#stat-subscribed')?.textContent === '1')
  check('导航订阅徽章=1', doc.querySelector('#sub-badge')?.textContent === '1')
  check('订阅按钮文案', doc.querySelector('.item-card .sub-btn')?.textContent.includes('已订阅'))
  // 等待模拟安装完成（4 步 × 350ms）
  await sleep(1500)
  const installedList = JSON.parse(dom.window.localStorage.getItem('harness_workshop_installed_list') || '[]')
  check('安装完成后写入 installed_list', installedList.includes(subId), JSON.stringify(installedList))
  check('卡片徽标变为已安装', doc.querySelector('.item-card.subscribed .card-sub-badge')?.textContent.includes('已安装'),
    `实际 ${doc.querySelector('.item-card.subscribed .card-sub-badge')?.textContent}`)
  // 取消订阅 = 卸载（demo 模型）
  doc.querySelector('.item-card .sub-btn')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(200)
  check('取消订阅后 subscribed 为空', (JSON.parse(dom.window.localStorage.getItem('harness_workshop_subscribed_list') || '[]')).length === 0)
  check('取消订阅后 installed 为空', (JSON.parse(dom.window.localStorage.getItem('harness_workshop_installed_list') || '[]')).length === 0)

  console.log('== 7. 您的订阅 Tab ==')
  dom.window.location.hash = '#/subscribed'
  await sleep(300)
  check('空订阅态显示', !doc.querySelector('#empty-state')?.hidden)
  check('空状态标题', doc.querySelector('#empty-title')?.textContent === '您还没有订阅任何插件')

  console.log('== 8. 详情页与焦点管理 ==')
  // 选一个同时具备更新日志与评论的条目用于 Esc/评论测试（数据驱动）
  const detailItem = ITEMS.find((i) => (i.changelog || []).length >= 2 && (i.comments || []).length >= 3) || ITEMS[0]
  dom.window.location.hash = '#/browse'
  await sleep(200)
  const cardEl = doc.querySelector('.item-card')
  const cardId = cardEl?.dataset.id
  const clickedItem = ITEMS.find((i) => i.id === cardId) || detailItem
  cardEl?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  check('详情视图可见', !doc.querySelector('#view-detail').hidden)
  check('详情标题与卡片一致', doc.querySelector('.detail-title')?.textContent === clickedItem.title,
    `实际 ${doc.querySelector('.detail-title')?.textContent}`)
  check('进入详情后焦点在返回按钮', doc.activeElement?.id === 'detail-back', `实际 ${doc.activeElement?.id || doc.activeElement?.tagName}`)
  check('侧栏统计', doc.querySelectorAll('.side-row').length === 6 + (clickedItem.version ? 1 : 0))
  check(`更新日志条目数=${(clickedItem.changelog || []).length}`, doc.querySelectorAll('.changelog-item').length === (clickedItem.changelog || []).length)
  check(`评论列表渲染=${(clickedItem.comments || []).length} 条`, doc.querySelectorAll('.comment-item').length === (clickedItem.comments || []).length)
  check('详情订阅按钮', doc.querySelector('#detail-sub') !== null)

  // GitHub 源码入口（数据驱动：有 source 显示，无则不显示）
  const gh = doc.querySelector('.detail-gh')
  if (clickedItem.source && clickedItem.source.url) {
    check('GitHub 源码入口存在', gh !== null && gh.getAttribute('href') === clickedItem.source.url,
      `实际 ${gh?.getAttribute('href')}`)
    check('GitHub 链接新标签打开', gh?.getAttribute('target') === '_blank' && (gh?.getAttribute('rel') || '').includes('noopener'))
  } else {
    check('无 source 时不显示 GitHub 入口', gh === null)
  }
  if (clickedItem.version) {
    check('详情元信息展示版本', (doc.querySelector('.detail-meta')?.textContent || '').includes('v' + clickedItem.version))
  }

  // 详情页订阅 → 自动安装（进度条 → 已安装 → 卸载）
  doc.querySelector('#detail-sub')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(200)
  check('详情订阅后按钮进入安装中', doc.querySelector('#detail-sub')?.disabled === true &&
    (doc.querySelector('#detail-sub')?.textContent || '').includes('安装中'),
    `实际 ${doc.querySelector('#detail-sub')?.textContent}`)
  check('安装进度条可见', !doc.querySelector('#install-bar')?.hidden)
  await sleep(1500)
  check('详情安装完成后按钮显示已安装', (doc.querySelector('#detail-sub')?.textContent || '').includes('已安装'),
    `实际 ${doc.querySelector('#detail-sub')?.textContent}`)
  doc.querySelector('#detail-sub')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(200)
  check('卸载后按钮恢复订阅文案', (doc.querySelector('#detail-sub')?.textContent || '').includes('订阅并安装'),
    `实际 ${doc.querySelector('#detail-sub')?.textContent}`)

  doc.querySelector('#detail-back')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  check('返回后焦点回到原卡片', doc.activeElement?.dataset?.id === cardId, `实际 ${doc.activeElement?.dataset?.id || doc.activeElement?.tagName}`)

  console.log('== 9. Esc 返回浏览 ==')
  // 选一个与第 8 节打开的卡片不同的条目，确保 hash 一定发生变化
  const escItem = ITEMS.find((i) => i.id !== cardId) || detailItem
  dom.window.location.hash = '#/item/' + escItem.id
  await sleep(300)
  check('详情页可见', !doc.querySelector('#view-detail').hidden)
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(300)
  check('Esc 返回浏览视图', doc.querySelector('#view-detail').hidden && !doc.querySelector('#view-browse').hidden)
  check('Esc 后 URL 同步为浏览页', dom.window.location.hash === '#/browse', `实际 ${dom.window.location.hash}`)

  console.log('== 10. 订阅按钮回车不误导航 ==')
  const hashBefore = dom.window.location.hash
  const subFocusBtn = doc.querySelector('.item-card .sub-btn')
  subFocusBtn?.focus()
  subFocusBtn?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await sleep(150)
  check('回车不跳转详情页', dom.window.location.hash === hashBefore, `实际 ${dom.window.location.hash}`)

  console.log('== 11. 评论提交 ==')
  dom.window.location.hash = '#/item/' + detailItem.id
  await sleep(300)
  const ci = doc.querySelector('#comment-input')
  ci.value = '冒烟测试评论：这个插件太棒了！'
  ci.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await sleep(150)
  const comments = doc.querySelectorAll('.comment-item')
  const firstComment = comments[0]?.querySelector('.comment-content')?.textContent
  check('新评论置顶显示', firstComment === '冒烟测试评论：这个插件太棒了！', `实际 ${firstComment}`)
  check(`评论数=${(detailItem.comments || []).length + 1}`, doc.querySelector('#comment-count')?.textContent.includes(String((detailItem.comments || []).length + 1)))
  const stored = JSON.parse(dom.window.localStorage.getItem('harness_workshop_comments') || '{}')
  check('评论持久化到 localStorage', Array.isArray(stored[detailItem.id]))

  dom.window.close()

  console.log(`== 12. file:// 回退（内嵌数据，${ITEMS.length} 条） ==`)
  const indexPath = fileURLToPath(new URL('../index.html', import.meta.url)).replace(/\\/g, '/')
  const { dom: dom2, errors: errors2 } = await load('file:///' + indexPath + '?hw-demo-install=1', { waitMs: 700 })
  const cards2 = dom2.window.document.querySelectorAll('.item-card')
  check(`file:// 下仍渲染 ${ITEMS.length} 张卡片`, cards2.length === ITEMS.length, `实际 ${cards2.length}`)
  check('file:// 无 JS 错误', errors2.length === 0, JSON.stringify(errors2.slice(0, 3)))
  dom2.window.close()

  console.log(failures === 0 ? '\n✔ 全部冒烟测试通过' : `\n✘ ${failures} 项测试失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
