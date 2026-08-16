/**
 * fetch-github.mjs — 从 GitHub 拉取真实插件数据，驱动 Harness 创意工坊的「真实安装」。
 *
 * 流程：
 *   1. 搜索 GitHub 仓库（默认话题 topic:dsh-plugin，可用位置参数覆盖，如 node scripts/fetch-github.mjs ai-plugin）
 *   2. 对每个仓库尝试拉取 plugin.manifest.json（本工坊的 PluginManifest 标准，见 schema/）
 *      有 manifest → 以 manifest 字段为准；没有 → 用仓库元数据兜底（名称/描述/Star/更新时间）
 *   3. 拉取最新 Release：若含 .js/.cjs/.mjs/.tgz/.zip 安装包，则写入 source.asset_url，
 *      订阅后安装将真实下载该包（source.install = "github"）；无安装包则保持演示安装（"demo"）
 *   4. 合并写入 mock-data/workshop_items.json（默认【合并】模式，保留已有演示数据；
 *      用 --replace 可完全替换）
 *
 * 用法：
 *   node scripts/fetch-github.mjs [话题] [--max N] [--out 路径] [--replace] [--dry-run]
 *   node scripts/fetch-github.mjs --fixture scripts/fixtures/github-dsh-plugin.sample.json   # 离线验证管线
 *   环境变量：GITHUB_TOKEN（未登录限流较严：搜索 10 次/分、核心 API 60 次/时）
 * 示例：
 *   node scripts/fetch-github.mjs                    # 拉取 topic:dsh-plugin，合并入现有数据
 *   node scripts/fetch-github.mjs dsh-plugin --max 5 # 只看前 5 个
 *   node scripts/fetch-github.mjs --dry-run          # 只打印预览，不写文件
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { lookup } from 'node:dns'
import { resolve4 } from 'node:dns/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DEFAULT_OUT = join(ROOT, 'mock-data', 'workshop_items.json')

/* ---------------------------- CLI 解析 ---------------------------- */

const args = process.argv.slice(2)
let topic = 'dsh-plugin'
let max = 10
let outPath = DEFAULT_OUT
let replace = false
let dryRun = false
let fixturePath = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--max') max = Math.max(1, Math.min(100, Number(args[++i]) || 10))
  else if (a === '--out') outPath = args[++i]
  else if (a === '--replace') replace = true
  else if (a === '--dry-run') dryRun = true
  else if (a === '--fixture') fixturePath = args[++i]
  else if (!a.startsWith('--')) topic = a
}

/* ---------------------------- 网络层（含 hosts 绕过） ---------------------------- */

const TOKEN = process.env.GITHUB_TOKEN || ''
const HEADERS = {
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'harness-workshop-fetcher',
  'X-GitHub-Api-Version': '2022-11-28',
}
if (TOKEN) HEADERS.Authorization = 'Bearer ' + TOKEN

// 检测 hosts 是否把 GitHub 域名指向 127.0.0.1（dns.lookup 走 hosts，dns.resolve4 走真实 DNS）
async function hostsBlocked(host) {
  try {
    const ip = await new Promise((res) => lookup(host, (e, a) => (e ? res(null) : res(a))))
    if (!ip || ip !== '127.0.0.1') return false
    const real = await resolve4(host).catch(() => [])
    return real.some((r) => r !== '127.0.0.1')
  } catch { return false }
}

let BYPASS = false
async function initNetwork() {
  if (await hostsBlocked('api.github.com') || await hostsBlocked('raw.githubusercontent.com')) {
    BYPASS = true
    console.log('ℹ 检测到 hosts 将 GitHub 指向 127.0.0.1，已启用「真实 IP 直连」绕过（无需修改系统 hosts）')
  }
}

/**
 * 统一网络请求：返回 { ok, status, json(), text(), header(name) }。
 * 默认走全局 fetch；检测到 hosts 屏蔽时改用 dns.resolve4 拿真实 IP + https 直连（自动跟随重定向）。
 */
async function netFetch(url, opts = {}) {
  const u = new URL(url)
  if (!BYPASS) {
    try {
      const res = await fetch(u, opts)
      return {
        ok: res.ok,
        status: res.status,
        json: () => res.json(),
        text: () => res.text(),
        header: (k) => res.headers.get(k),
      }
    } catch { /* 网络异常时尝试绕过路径 */ }
  }
  const ips = await resolve4(u.hostname).catch(() => { throw new Error(`无法解析 ${u.hostname}（DNS 异常）`) })
  const body = await new Promise((resolve, reject) => {
    const req = https.request(u, {
      method: opts.method || 'GET',
      headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'harness-workshop-fetcher', ...(opts.headers || {}) },
      // Node 24 以 all:true 调用 lookup，需返回地址对象数组；否则返回单个地址
      lookup: (_h, o, cb) => {
        if (o && o.all) cb(null, ips.map((ip) => ({ address: ip, family: 4 })))
        else cb(null, ips[0], 4)
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        return resolve(netFetch(new URL(res.headers.location, u).href, opts))
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', (e) => reject(new Error(`网络请求失败：${e.message}`)))
    req.end()
  })
  return {
    ok: body.status >= 200 && body.status < 300,
    status: body.status,
    json: () => JSON.parse(body.body),
    text: () => Promise.resolve(body.body),
    header: (k) => (body.headers && body.headers[k.toLowerCase()]) || null,
  }
}

/** GET 一个 GitHub API 端点；非 2xx 返回 null（404 等视为无数据），限流抛错 */
async function gh(url) {
  const res = await netFetch(url, { headers: HEADERS })
  if (res.status === 403 || res.status === 429) {
    const retry = res.header('retry-after')
    throw new Error(`GitHub 限流（${res.status}）${retry ? `：${retry}s 后重试` : '：请设置 GITHUB_TOKEN 提高限额'}`)
  }
  if (!res.ok) return null
  return res.json()
}

/* ---------------------------- 标签映射 ---------------------------- */

/** 英文 GitHub topics → 工坊中文分类标签（启发式；未匹配的话题保留原文） */
const TAG_RULES = [
  { keys: ['theme', 'dark', 'color'], tags: ['UI美化', '主题'] },
  { keys: ['layout', 'panel', 'sidebar'], tags: ['UI美化'] },
  { keys: ['workflow', 'automation', 'pipeline', 'cron', 'scheduler'], tags: ['效率工具', '工作流'] },
  { keys: ['agent', 'assistant'], tags: ['Agent预设'] },
  { keys: ['tool', 'utility', 'helper'], tags: ['效率工具'] },
  { keys: ['integration', 'api', 'connect', 'sync'], tags: ['工具集成'] },
  { keys: ['template', 'prompt'], tags: ['模板'] },
  { keys: ['tutorial', 'guide', 'learn', 'docs'], tags: ['教程'] },
  { keys: ['translate', 'translation'], tags: ['效率工具'] },
]

function mapTags(topics = []) {
  const tags = new Set()
  const lower = topics.map((t) => String(t).toLowerCase())
  for (const rule of TAG_RULES) {
    if (lower.some((t) => rule.keys.some((k) => t.includes(k)))) rule.tags.forEach((t) => tags.add(t))
  }
  // 规则没命中任何分类时，保留原始话题作为兜底标签
  if (tags.size === 0) topics.forEach((t) => tags.add(String(t)))
  return [...tags]
}

const dedupe = (arr) => [...new Set(arr.filter(Boolean))]

/* ---------------------------- 条目构建 ---------------------------- */

/** 尝试拉取仓库根目录的 plugin.manifest.json（经 raw.githubusercontent，不占核心 API 配额） */
async function fetchManifest(repo, branch) {
  const url = `https://raw.githubusercontent.com/${repo.full_name}/${branch}/plugin.manifest.json`
  try {
    const res = await netFetch(url, { headers: { 'User-Agent': 'harness-workshop-fetcher' } })
    if (!res.ok) return null
    const json = await res.json()
    if (json && typeof json === 'object' && json.id && json.title) return json
    return null
  } catch { return null }
}

/** 拉取最新 Release，返回含安装包资产信息 */
async function fetchLatestRelease(repo) {
  const rel = await gh(`https://api.github.com/repos/${repo.full_name}/releases/latest`)
  if (!rel || !rel.tag_name) return null
  const assets = Array.isArray(rel.assets) ? rel.assets : []
  const asset = assets.find((a) => /\.(js|cjs|mjs|tgz|zip)$/i.test(a.name))
  return { tag_name: rel.tag_name, published_at: rel.published_at, body: rel.body || '', asset }
}

/**
 * 构建条目：优先 manifest（schema/plugin-manifest.schema.json），缺省用仓库元数据兜底。
 * preloaded 用于离线 fixture 模式（{ manifest, release }），跳过网络请求。
 */
async function buildItem(repo, preloaded = null) {
  const manifest = preloaded ? preloaded.manifest : await fetchManifest(repo, repo.default_branch || 'main')
  const release = preloaded ? preloaded.release : await fetchLatestRelease(repo)

  const id = (manifest && manifest.id) || repo.name
  const item = {
    id,
    title: (manifest && manifest.title) || repo.name,
    author: (manifest && manifest.author) || (repo.owner && repo.owner.login) || 'GitHub 未知作者',
    stats: (manifest && manifest.stats) || {
      subscribers: repo.stargazers_count || 0,
      rating: 0,
      views: (repo.stargazers_count || 0) * 20,
    },
    update_time: Date.parse(repo.pushed_at || repo.updated_at) || Date.now(),
    tags: dedupe([...(manifest && manifest.tags) || [], ...mapTags(repo.topics || [])]),
    thumbnail: `thumbs/${id}.svg`,
    source: {
      type: 'github',
      url: repo.html_url,
      install: 'demo',   // 无安装包时保持演示安装
    },
  }

  // 有 Release 安装包 → 真实安装
  if (release && release.asset) {
    item.source.install = 'github'
    item.source.asset_url = release.asset.browser_download_url
    item.source.asset_name = release.asset.name
  }

  // 可选字段：manifest 优先，缺省用仓库元数据
  item.description = (manifest && manifest.description) || repo.description || ''
  item.version = (manifest && manifest.version) || (release ? release.tag_name.replace(/^v/, '') : undefined)
  if (manifest && Array.isArray(manifest.changelog) && manifest.changelog.length) item.changelog = manifest.changelog
  else if (release && release.published_at) {
    const firstNote = (release.body || 'GitHub Release').split('\n').map((l) => l.trim()).find(Boolean) || 'GitHub Release'
    item.changelog = [{ version: release.tag_name.replace(/^v/, ''), date: Date.parse(release.published_at), notes: [firstNote.slice(0, 120)] }]
  }
  if (manifest && Array.isArray(manifest.comments)) item.comments = manifest.comments
  if (manifest && manifest.compat) item.compat = manifest.compat
  // manifest 自带的 source（如独立安装包地址）优先于仓库推断
  if (manifest && manifest.source && manifest.source.url) {
    item.source = { ...item.source, ...manifest.source }
    if (!item.source.install) item.source.install = manifest.source.type === 'github' ? 'github' : 'demo'
  }

  return { item, hadManifest: !!manifest }
}

/* ---------------------------- 主流程 ---------------------------- */

async function main() {
  await initNetwork()
  let repos = []
  let totalCount = 0

  if (fixturePath) {
    // 离线 fixture 模式：不访问网络，用样本数据验证整条管线
    let fixture
    try { fixture = JSON.parse(readFileSync(join(ROOT, fixturePath), 'utf8')) } catch (e) { console.error(`✗ 无法读取 fixture ${fixturePath}：${e.message}`); process.exit(1) }
    topic = fixture.topic || topic
    repos = (fixture.repos || []).slice(0, max)
    totalCount = repos.length
    console.log(`🔍 离线 fixture：${fixturePath}（topic:${topic}，${repos.length} 个仓库样本）`)
  } else {
    console.log(`🔍 搜索 GitHub：topic:${topic}（本次最多处理 ${max} 个仓库）`)
    const search = await gh(`https://api.github.com/search/repositories?q=${encodeURIComponent('topic:' + topic)}&sort=updated&order=desc&per_page=${max}`)
    if (!search || !Array.isArray(search.items)) {
      console.error(`✗ 搜索失败（${search ? JSON.stringify(search).slice(0, 200) : '请求被拒绝'}）`)
      process.exit(1)
    }
    repos = search.items.slice(0, max)
    totalCount = search.total_count
    console.log(`  命中 ${totalCount} 个仓库，本次处理 ${repos.length} 个`)
  }

  if (repos.length === 0) {
    if (dryRun) return
    if (!replace) {
      console.log(`  topic:${topic} 暂无仓库（话题可能较新）。合并模式：保持现有 mock-data 不变。`)
      return
    }
    // --replace 且空结果：写出空 items，明确告知
    const out = { generated_at: Date.now(), note: `由 scripts/fetch-github.mjs 拉取（topic:${topic}，${new Date().toISOString()}）—— 无结果`, items: [] }
    writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8')
    console.log(`  ⚠ 已用空结果覆盖 ${outPath}`)
    return
  }

  const fetched = []
  let withManifest = 0
  let withInstall = 0
  for (const repo of repos) {
    try {
      const preloaded = fixturePath
        ? { manifest: repo._manifest || null, release: repo._release || null }
        : null
      const { item, hadManifest } = await buildItem(repo, preloaded)
      fetched.push(item)
      if (hadManifest) withManifest++
      if (item.source.install === 'github') withInstall++
      console.log(`  · ${item.id.padEnd(30)} ${hadManifest ? '有 manifest' : '仓库兜底'}  ${item.source.install === 'github' ? '可真实安装' : '演示安装'}  ★${item.stats.subscribers || 0}`)
    } catch (e) {
      console.warn(`  ⚠ ${repo.full_name || repo.name} 处理失败：${e.message}`)
    }
  }

  // 合并（默认）或替换
  let items = fetched
  if (!replace) {
    let existing = []
    try { existing = (JSON.parse(readFileSync(DEFAULT_OUT, 'utf8')).items) || [] } catch { /* 首次运行无旧数据 */ }
    const seen = new Set(fetched.map((i) => i.id))
    items = [...fetched, ...existing.filter((i) => !seen.has(i.id))]
  }

  const out = {
    generated_at: Date.now(),
    note: `由 scripts/fetch-github.mjs 从 GitHub 拉取（topic:${topic}，${new Date().toISOString()}）；${withManifest} 个含 plugin.manifest.json，${withInstall} 个可真实安装`,
    items,
  }

  if (dryRun) {
    console.log(`\n[dry-run] 将写入 ${items.length} 个条目（新增 ${fetched.length}）到 ${outPath}：`)
    items.slice(0, 12).forEach((i) => console.log(`  - ${i.id}  ${i.title}  [${(i.source && i.source.install) || 'demo'}]`))
    if (items.length > 12) console.log(`  … 等共 ${items.length} 条`)
    return
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`\n✓ 已写入 ${outPath}：共 ${items.length} 个条目（新增 ${fetched.length}，其中 ${withInstall} 个可真实安装）`)
  console.log('  下一步：npm run build 重新生成内嵌数据与封面图')
}

main().catch((e) => { console.error('✗ 脚本失败：', e.message); process.exit(1) })
