/**
 * sync-github.mjs — Harness 创意工坊 · GitHub 实时同步（host 半边）。
 *
 * 职责：扫描 GitHub `topic:dsh-plugin` 仓库（按最近更新排序），逐个做**尽力而为**
 * 的 DSH 插件校验（根目录 plugin.manifest.json / package.json 的 dsh 清单），
 * 生成与 mock-data 同构的条目列表（含封面 data URI）。
 *
 * 注意：校验只是给条目打 `install: github|demo` 标记（展示用）。订阅任意条目后，
 * 安装链路（agent / host API）都会自行深挖仓库子目录与 Release，因此校验漏判
 * 不影响条目入列与新插件自动同步。
 *
 * 网络层：
 *   - api.github.com（搜索）走 hosts 绕过（dns.resolve4 真实 IP + https 直连）；
 *   - 清单校验优先走 cdn.jsdelivr.net（GitHub 镜像 CDN，无限流），网络失败时
 *     回退 api.github.com contents（计入配额，受 60 次/小时限制）。
 */

import { resolve4 } from 'node:dns/promises'
import { lookup } from 'node:dns'
import https from 'node:https'

const TOPIC = 'dsh-plugin'
const SEARCH_URL = `https://api.github.com/search/repositories?q=topic:${TOPIC}&sort=updated&order=desc&per_page=100`
const UA = 'harness-workshop-sync'
const MAX_BYTES = 8 * 1024 * 1024

/* ------------------------------ 网络层 ------------------------------ */

/** hosts 绕过 GET（api.github.com 等被 hosts 屏蔽的域名）。 */
function netFetch(url, { timeout = 20000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    let req
    const timer = setTimeout(() => { req && req.destroy(new Error('请求超时')); }, timeout)
    const finish = (v) => { clearTimeout(timer); resolve(v) }
    const fail = (e) => { clearTimeout(timer); reject(e) }
    resolve4(u.hostname)
      .then((ips) => {
        const pool = ips.filter((i) => i !== '127.0.0.1')
        const targets = pool.length ? pool : ips
        req = https.request(u, {
          method: 'GET',
          headers: { 'Accept-Encoding': 'identity', 'User-Agent': UA, ...headers },
          lookup: (_h, o, cb) => {
            if (o && o.all) cb(null, targets.map((ip) => ({ address: ip, family: 4 })))
            else cb(null, targets[0], 4)
          },
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume()
            return netFetch(new URL(res.headers.location, u).href, { timeout, headers }).then(finish, fail)
          }
          const chunks = []
          let total = 0
          res.on('data', (c) => { total += c.length; if (total > MAX_BYTES) { req.destroy(new Error('响应超限')); return } chunks.push(c) })
          res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        })
        req.on('error', fail)
        req.end()
      })
      .catch(fail)
  })
}

/** jsdelivr CDN GET（普通 fetch，无限流）。返回 {status, body} 或 null（网络失败）。 */
async function jsdelivrFetch(owner, repo, branch, filePath) {
  try {
    const res = await fetch(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filePath}`, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': UA },
    })
    return { status: res.status, body: res.status === 200 ? await res.text() : '' }
  } catch {
    return null
  }
}

/* ------------------------------ GitHub 数据 ------------------------------ */

/** 搜索 topic:dsh-plugin 仓库（最近更新排序，最新在前）。 */
async function searchTopicRepos(token) {
  const res = await netFetch(SEARCH_URL, {
    timeout: 30000,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (res.status === 403) throw new Error('GitHub API 限流（403）——可设置 GITHUB_TOKEN 提升配额')
  if (res.status !== 200) throw new Error(`GitHub 搜索失败 HTTP ${res.status}`)
  const json = JSON.parse(res.body.toString('utf8'))
  return (json.items || []).map((r) => ({
    full_name: r.full_name,
    description: r.description || '',
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    default_branch: r.default_branch || 'main',
  }))
}

/** GitHub API contents 兜底（计入配额）。 */
async function apiContents(owner, repo, branch, filePath, token) {
  try {
    const res = await netFetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
      { timeout: 15000, headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA, ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
    )
    if (res.status === 200) {
      try { return { status: 200, body: Buffer.from(JSON.parse(res.body.toString('utf8')).content, 'base64').toString('utf8') } } catch { return { status: 500, body: '' } }
    }
    return { status: res.status, body: '' }
  } catch {
    return null
  }
}

/**
 * 尽力而为校验：plugin.manifest.json 或 package.json 的 dsh 清单。
 * 命中 → { valid, meta:{id,title,version} }；否则 { valid:false }。
 * @param token - GITHUB_TOKEN（提升 API 兜底配额）。
 */
async function validateRepo(fullName, defaultBranch, token) {
  const [owner, repo] = fullName.split('/')
  const branch = defaultBranch || 'main'
  const check = async (filePath) => {
    let r = await jsdelivrFetch(owner, repo, branch, filePath)
    if (r === null) r = await apiContents(owner, repo, branch, filePath, token) // jsdelivr 网络失败 → API 兜底
    return r
  }

  let r = await check('plugin.manifest.json')
  if (r && r.status === 200) {
    try {
      const j = JSON.parse(r.body)
      if (j && j.id && j.title) return { valid: true, meta: { id: j.id, title: j.title, version: j.version } }
    } catch { /* 继续 package.json */ }
  }

  r = await check('package.json')
  if (r && r.status === 200) {
    try {
      const j = JSON.parse(r.body)
      const dsh = j && j.dsh
      if (dsh && (dsh.client || (dsh.bundle && typeof dsh.bundle === 'object'))) {
        const id = (j.name || repo).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || repo
        return { valid: true, meta: { id, title: j.name || repo, version: j.version } }
      }
    } catch { /* 无效 */ }
  }
  return { valid: false, meta: null }
}

/** 并发上限工具。 */
async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const idx = i++
      out[idx] = await fn(arr[idx], idx)
    }
  }))
  return out
}

/* ------------------------------ 封面（data URI） ------------------------------ */

function hueOf(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function thumbDataUri(id, title) {
  const hue = hueOf(id)
  const h2 = (hue + 40) % 360
  const chars = [...String(title || id)]
  const lines = [chars.slice(0, 12).join(''), chars.length > 12 ? chars.slice(12, 24).join('') + '…' : ''].filter(Boolean)
  const tspans = lines.map((l, i) => `<tspan x="320" y="${175 + i * 52}">${esc(l)}</tspan>`).join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 55%, 26%)"/>
      <stop offset="55%" stop-color="hsl(${h2}, 60%, 15%)"/>
      <stop offset="100%" stop-color="hsl(${h2}, 65%, 8%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="72%" cy="22%" r="55%">
      <stop offset="0%" stop-color="hsl(${hue}, 90%, 62%)" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="hsl(${hue}, 90%, 62%)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="640" height="360" fill="url(#bg)"/>
  <circle cx="500" cy="70" r="230" fill="url(#glow)"/>
  <circle cx="92" cy="300" r="150" fill="hsl(${hue}, 70%, 45%)" opacity="0.22"/>
  <text x="320" y="150" text-anchor="middle" font-family="'Motiva Sans','Segoe UI','Microsoft YaHei',sans-serif" font-size="34" font-weight="700" fill="#ffffff" letter-spacing="2">${tspans}</text>
  <text x="620" y="342" text-anchor="end" font-family="'Motiva Sans','Segoe UI','Microsoft YaHei',sans-serif" font-size="13" fill="rgba(255,255,255,0.40)">${esc(id)}</text>
</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

/* ------------------------------ 主入口 ------------------------------ */

function itemFromRepo(r, validated, meta) {
  const [owner, repo] = r.full_name.split('/')
  const id = (meta && meta.id) || repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || repo
  const item = {
    id,
    title: (meta && meta.title) || r.full_name,
    author: owner,
    stats: { subscribers: 0, rating: 0, rating_count: 0, views: 0 },
    update_time: Date.parse(r.updated_at) || Date.now(),
    tags: ['dsh-plugin'],
    thumbnail: thumbDataUri(id, (meta && meta.title) || r.full_name),
    description: r.description || '',
    source: {
      type: 'github',
      url: `https://github.com/${r.full_name}`,
      install: validated ? 'github' : 'demo',
    },
    synced: true,
  }
  if (meta && meta.version) item.version = meta.version
  return item
}

/**
 * 执行一次全量同步。
 * @param opts.token - GITHUB_TOKEN（提升 API 兜底配额）。
 * @param opts.maxRepos - 最多收录仓库数（按最近更新取前 N）。
 * @param opts.cache - 上次校验缓存 { repoFullName: { valid, meta, updated_at } }，未变更仓库复用。
 * @returns { items, stats, cache }
 */
export async function syncItems({ token = '', maxRepos = 60, cache = {} } = {}) {
  const repos = (await searchTopicRepos(token)).slice(0, maxRepos)
  const items = []
  const nextCache = {}
  let validated = 0
  let fromCache = 0

  await mapLimit(repos, 6, async (r) => {
    const prev = cache[r.full_name]
    if (prev && prev.updated_at === r.updated_at && prev.checkedAt && Date.now() - prev.checkedAt < 24 * 3600 * 1000) {
      if (prev.valid) validated++
      fromCache++
      nextCache[r.full_name] = prev
      items.push(itemFromRepo(r, prev.valid, prev.meta))
      return
    }
    const { valid, meta } = await validateRepo(r.full_name, r.default_branch, token)
    if (valid) validated++
    nextCache[r.full_name] = { valid, meta, updated_at: r.updated_at, checkedAt: Date.now() }
    items.push(itemFromRepo(r, valid, meta))
  })

  return { items, stats: { total: items.length, validated, demo: items.length - validated, fromCache }, cache: nextCache }
}
