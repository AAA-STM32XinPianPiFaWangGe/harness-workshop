/**
 * workshop-data.js — Harness 创意工坊 · 数据服务（host 半边）。
 *
 * 职责：
 *   - 维护 GitHub 同步结果缓存（$DSH_HOME/workshop-items.json），重启不丢；
 *   - 缓存过期（默认 1 小时）或收到刷新请求时，后台触发一次全量同步；
 *   - 提供定时器（默认每 6 小时）由插件 apply 启动。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FILE = 'workshop-items.json'
/** 缓存超过该时长视为过期，打开工坊时触发后台同步。 */
const STALE_MS = 60 * 60 * 1000
/** 定时全量同步间隔。 */
const INTERVAL_MS = 6 * 60 * 60 * 1000
/** 每次同步最多收录仓库数（GitHub 上该话题有 4000+ 仓库，取最近活跃的前 N）。 */
const MAX_REPOS = 200

function storePath() {
  const home = process.env.DSH_HOME && path.isAbsolute(process.env.DSH_HOME)
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, FILE)
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')) } catch { return null }
}

function writeStore(data) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.error(`[harness-workshop] 同步结果写入失败: ${err && err.message || err}`)
  }
}

let syncing = false
let cached = readStore()

/** 后台执行一次全量同步（并发去重）。返回最新数据快照。 */
async function runSync() {
  if (syncing) return cached
  syncing = true
  try {
    const { syncItems } = await import('./sync-github.mjs')
    const token = process.env.GITHUB_TOKEN || ''
    const prevCache = (cached && cached.cache) || {}
    const { items, stats, cache } = await syncItems({ token, maxRepos: MAX_REPOS, cache: prevCache })
    const data = { syncedAt: Date.now(), stats, items, cache }
    writeStore(data)
    cached = data
    return data
  } catch (err) {
    console.error(`[harness-workshop] GitHub 同步失败: ${err && err.message || err}`)
    return cached
  } finally {
    syncing = false
  }
}

/**
 * 读取条目数据。缓存缺失/过期且未在同步时，立即在后台触发一次同步，
 * 本次调用先返回当前快照（可能为空，客户端轮询 syncedAt 即可等到新数据）。
 * @param opts.force - true 时强制后台刷新。
 */
function getItems({ force = false } = {}) {
  const stale = !cached || !cached.syncedAt || Date.now() - cached.syncedAt >= STALE_MS
  if ((stale || force) && !syncing) {
    runSync().catch(() => { /* 已内部记录 */ })
  }
  return {
    items: (cached && cached.items) || [],
    syncedAt: (cached && cached.syncedAt) || null,
    syncing,
    stats: (cached && cached.stats) || null,
    stale,
  }
}

/** 启动定时同步；返回 disposer。 */
function schedule() {
  const timer = setInterval(() => { runSync().catch(() => {}) }, INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

module.exports = { getItems, runSync, schedule, STALE_MS, INTERVAL_MS }
