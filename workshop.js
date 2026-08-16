/* ==========================================================================
 * Harness 创意工坊 — 核心交互逻辑
 * 复刻 Steam 创意工坊：排序 / 分类树 / 标签过滤 / 订阅管理 / 详情页 / 评论区
 * 依赖 js/data.js 提供的 window.WORKSHOP_DATA（内嵌模拟数据）；
 * 若通过 HTTP 访问，会优先尝试 fetch mock-data/workshop_items.json 保持与数据文件一致。
 * ========================================================================== */
(() => {
  'use strict'

  /* ---------------------------- 常量与配置 ---------------------------- */

  const LS_SUB = 'harness_workshop_subscribed_list'
  const LS_COMMENTS = 'harness_workshop_comments'
  const LS_LIKES = 'harness_workshop_likes'
  const LS_PREFS = 'harness_workshop_prefs'
  const LS_INSTALLED = 'harness_workshop_installed_list'

  /**
   * 模拟安装步骤（demo）：真实安装应由 DSH 宿主执行
   * 「下载 → 校验 → 写入本地插件目录 → 完成」；source.sha256 可作完整性校验位。
   */
  const INSTALL_STEPS = [
    { label: '正在下载插件包…', pct: 25, delay: 350 },
    { label: '正在校验清单与签名…', pct: 55, delay: 350 },
    { label: '正在写入本地插件目录…', pct: 85, delay: 350 },
    { label: '安装完成', pct: 100, delay: 0 },
  ]

  const SORTS = {
    popular:      { label: '最热门',     desc: '综合热度权重' },
    subscribers:  { label: '最多复刻',   desc: '按 GitHub 复刻数降序' },
    updated:      { label: '最近更新',   desc: '按更新时间降序' },
    rating:       { label: '最多星标',   desc: '按 GitHub 星标数降序' },
    views:        { label: '最多浏览',   desc: '按浏览量降序' },
  }

  /**
   * 多级分类树（对应截图左侧「浏览分类」）。
   * 叶子节点通过 tag 字段与插件标签映射；父节点聚合所有子节点。
   * 该结构为数据驱动，替换 CATEGORIES 即可换一套分类体系。
   */
  const CATEGORIES = [
    { id: 'all', name: '全部', children: [] },
    {
      id: 'ui', name: 'UI 美化', children: [
        { id: 'theme', name: '主题', tag: '主题' },
        { id: 'layout', name: '布局增强', tag: '布局增强' },
      ],
    },
    {
      id: 'efficiency', name: '效率工具', children: [
        { id: 'automation', name: '自动化', tag: '自动化' },
        { id: 'workflow', name: '工作流', tag: '工作流' },
      ],
    },
    {
      id: 'agent', name: 'Agent 扩展', children: [
        { id: 'agent-preset', name: 'Agent 预设', tag: 'Agent预设' },
        { id: 'integration', name: '工具集成', tag: '工具集成' },
      ],
    },
    {
      id: 'content', name: '内容创作', children: [
        { id: 'template', name: '模板', tag: '模板' },
        { id: 'tutorial', name: '教程', tag: '教程' },
      ],
    },
  ]

  /* ---------------------------- 工具函数 ---------------------------- */

  const $ = (sel) => document.querySelector(sel)

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  /** 数字格式化：12345 → 12,345（Steam 风格千分位） */
  function fmtNum(n) {
    return Number(n || 0).toLocaleString('zh-CN')
  }

  const DAY = 86400000

  /** 相对时间：X 分钟前 / X 小时前 / X 天前 / X 个月前 / X 年前 */
  function timeAgo(ts) {
    const diff = Date.now() - Number(ts)
    if (diff < 0) return '刚刚更新'
    if (diff < 60 * 1000) return '刚刚更新'
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前更新'
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前更新'
    if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' 天前更新'
    if (diff < 365 * DAY) return Math.floor(diff / (30 * DAY)) + ' 个月前更新'
    return Math.floor(diff / (365 * DAY)) + ' 年前更新'
  }

  function fmtDate(ts) {
    const d = new Date(Number(ts))
    const pad = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`
  }

  /**
   * 轻量描述渲染：转义 HTML 后支持 **加粗**、\n\n 分段、"- " 无序列表。
   */
  function parseDesc(text) {
    const p = esc(text).split(/\n\s*\n/)
    return p.map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '')
      const items = lines.filter((l) => /^[-•]\s+/.test(l))
      if (items.length === lines.length && items.length > 0) {
        const lis = items.map((l) => `<li>${inline(l.replace(/^[-•]\s+/, ''))}</li>`).join('')
        return `<ul>${lis}</ul>`
      }
      return `<p>${inline(lines.join('<br>'))}</p>`
    }).join('')
  }

  function inline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  }

  /** GitHub 星标：Octicon 星形图标 + 格式化数量（替代 Steam 式五星评分） */
  function githubStarsHTML(stars) {
    const n = Number(stars) || 0
    const icon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>'
    return `<span class="gh-stars" title="GitHub 星标 ${fmtNum(n)}">${icon}${fmtNum(n)}</span>`
  }

  function avatarHTML(name, color, cls = '') {
    return `<span class="avatar ${cls}" style="background:${esc(color || '#2a475e')}">${esc((name || '?').slice(0, 1))}</span>`
  }

  /** 头像色：由昵称派生稳定色 */
  function hueOf(name) {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
    return `hsl(${h}, 55%, 45%)`
  }

  /* ---------------------------- 数据加载 ---------------------------- */

  let ITEMS = []

  /** 合并内嵌（精选）数据与 host 实时同步数据：实时数据补充新条目，冲突时内嵌优先（保留 curated 字段）；
   *  stats 逐字段合并，保证实时条目的 GitHub 星标不被内嵌旧数据覆盖。 */
  function mergeItems(embedded, live) {
    const byId = new Map()
    for (const it of (live || [])) if (it && it.id) byId.set(it.id, it)
    for (const it of (embedded || [])) if (it && it.id) {
      const existing = byId.get(it.id)
      byId.set(it.id, existing
        ? { ...existing, ...it, stats: { ...(existing.stats || {}), ...(it.stats || {}) } }
        : it)
    }
    return [...byId.values()]
  }

  async function loadData() {
    const embedded = window.WORKSHOP_DATA && Array.isArray(window.WORKSHOP_DATA.items)
      ? window.WORKSHOP_DATA.items
      : []
    ITEMS = embedded // 内嵌数据先兜底（离线/独立模式也能立刻出界面）

    // 1) 尝试拉取 host 实时数据（DSH 内运行时同源；独立运行 404/失败自动忽略）
    let live = null
    try {
      const res = await fetch('/api/harness-workshop/items', { cache: 'no-store' })
      if (res.ok) {
        const json = await res.json()
        if (json && json.ok && Array.isArray(json.items)) {
          live = json.items
          state.liveSyncing = !!json.syncing && !json.syncedAt
          if (json.syncedAt) state.liveSyncAt = json.syncedAt
          if (live.length) {
            ITEMS = mergeItems(embedded, live)
            renderAll()
          }
        }
      }
    } catch (_) { /* 无 host（独立运行） */ }

    // 2) 首次同步进行中：后台轮询等待（不阻塞首屏），拿到新数据后原地刷新
    if (state.liveSyncing) pollLiveUntilReady()

    // 3) 独立 HTTP 模式（无 host）：走 mock-data 文件，保证与数据文件同步
    if (!live) {
      try {
        const res = await fetch('mock-data/workshop_items.json', { cache: 'no-store' })
        if (res.ok) {
          const json = await res.json()
          if (Array.isArray(json.items)) { ITEMS = mergeItems(embedded, json.items); renderAll(); return }
        }
      } catch (_) { /* file:// 或离线环境，回退内嵌数据 */ }
    }
  }

  /** 首次 GitHub 同步进行中时轮询 items 接口（每 15s，最多 5 分钟）。 */
  async function pollLiveUntilReady() {
    const embedded = window.WORKSHOP_DATA && Array.isArray(window.WORKSHOP_DATA.items)
      ? window.WORKSHOP_DATA.items
      : []
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 15000))
      try {
        const res = await fetch('/api/harness-workshop/items', { cache: 'no-store' })
        if (!res.ok) continue
        const json = await res.json()
        if (!(json && json.ok)) continue
        if (json.syncedAt) {
          state.liveSyncAt = json.syncedAt
          state.liveSyncing = false
          if (Array.isArray(json.items) && json.items.length) {
            ITEMS = mergeItems(embedded, json.items)
            renderAll()
          }
          return
        }
      } catch (_) { return } // host 消失（切回独立模式）即放弃
    }
  }

  /* ---------------------------- 应用状态 ---------------------------- */

  const state = {
    tab: 'browse',              // browse | subscribed
    category: 'all',            // 分类树选中的节点 id（持久化）
    tags: new Set(),            // 标签过滤器
    sort: 'popular',            // popular | subscribers | updated | rating | views（持久化）
    search: '',
    subscribed: new Set(readLS(LS_SUB, [])),
    installed: new Set(readLS(LS_INSTALLED, [])),  // 已安装（demo：订阅并安装完成）
    installing: new Set(),                          // 安装中（瞬时状态，不持久化）
    installPct: {},                                 // { itemId: 进度 0-100 }
    extraComments: readLS(LS_COMMENTS, {}),   // { itemId: [comment, ...] }（本地新增评论）
    likes: new Set(readLS(LS_LIKES, [])),     // 已点赞的评论 key
    openNodes: new Set(['ui', 'efficiency', 'agent', 'content']), // 分类树展开状态
    view: 'browse',             // browse | detail（当前视图，用于焦点管理）
    detailFrom: null,           // 进入详情页前的卡片 id（返回时恢复焦点）
    pendingTagFocus: null,      // 详情页点击标签返回后要聚焦的标签
    pendingSearchFocus: false,  // 详情页点击作者返回后要聚焦的搜索框
    liveSyncAt: null,           // host GitHub 同步时间戳（毫秒）
    liveSyncing: false,         // 首次同步进行中
    page: 1,                    // 网格翻页（1-based）
  }

  // 恢复持久化的排序/分类（分类若已不存在则回退 'all'）
  const savedPrefs = readLS(LS_PREFS, {})
  if (Object.prototype.hasOwnProperty.call(SORTS, savedPrefs.sort)) state.sort = savedPrefs.sort
  if (categoryExists(savedPrefs.category)) state.category = savedPrefs.category

  function savePrefs() {
    writeLS(LS_PREFS, { sort: state.sort, category: state.category })
  }

  function readLS(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch (_) { return fallback }
  }
  function writeLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch (_) { /* 隐私模式忽略 */ }
  }

  /* ---------------------------- 排序算法 ---------------------------- */

  /**
   * 「最热门」综合权重算法：
   *   score = 订阅数 × 1.0
   *         + GitHub 星标 × 2.0
   *         + 浏览量 × 0.02
   *         + 评分 × 180
   *         + 评分人数 × 0.05
   *         + 更新新鲜度加成（7 天内 +200 / 30 天内 +80 / 90 天内 +20）
   * 权重可调，位于本函数顶部，便于后续按真实数据校准。
   */
  function popularityScore(item) {
    const W = { subscriber: 1.0, stars: 2.0, view: 0.02, rating: 180, ratingCount: 0.05 }
    const s = item.stats || {}
    const age = Date.now() - Number(item.update_time)
    let freshness = 0
    if (age <= 7 * DAY) freshness = 200
    else if (age <= 30 * DAY) freshness = 80
    else if (age <= 90 * DAY) freshness = 20
    return (s.subscribers || 0) * W.subscriber
      + (s.stars || 0) * W.stars
      + (s.views || 0) * W.view
      + (s.rating || 0) * W.rating
      + (s.rating_count || 0) * W.ratingCount
      + freshness
  }

  function sortItems(list) {
    const arr = [...list]
    switch (state.sort) {
      case 'subscribers':
        return arr.sort((a, b) => (b.stats?.forks ?? 0) - (a.stats?.forks ?? 0) || (b.stats?.subscribers ?? 0) - (a.stats?.subscribers ?? 0))
      case 'views':
        return arr.sort((a, b) => (b.stats?.views ?? 0) - (a.stats?.views ?? 0))
      case 'updated':
        return arr.sort((a, b) => Number(b.update_time) - Number(a.update_time))
      case 'rating':
        return arr.sort((a, b) => {
          const d = (b.stats?.stars ?? 0) - (a.stats?.stars ?? 0)
          if (d !== 0) return d
          return (b.stats?.subscribers ?? 0) - (a.stats?.subscribers ?? 0)
        })
      default:
        return arr.sort((a, b) => popularityScore(b) - popularityScore(a))
    }
  }

  /* ---------------------------- 过滤 ---------------------------- */

  /** 分类 id 是否存在于分类树中（用于校验持久化的分类选择） */
  function categoryExists(id) {
    if (typeof id !== 'string') return false
    return CATEGORIES.some((n) => n.id === id || (n.children || []).some((c) => c.id === id))
  }

  function categoryNode(id) {
    for (const node of CATEGORIES) {
      if (node.id === id) return node
      const child = (node.children || []).find((c) => c.id === id)
      if (child) return child
    }
    return CATEGORIES[0]
  }

  /** 节点匹配的标签集合：叶子取自身 tag，父节点取全部子节点 tag */
  function categoryTags(id) {
    const node = categoryNode(id)
    if (!node.children || node.children.length === 0) {
      return node.tag ? [node.tag] : []
    }
    return node.children.map((c) => c.tag).filter(Boolean)
  }

  function matchesCategory(item) {
    const tags = categoryTags(state.category)
    if (tags.length === 0) return true
    return tags.some((t) => (item.tags || []).includes(t))
  }

  function matchesTags(item) {
    if (state.tags.size === 0) return true
    return [...state.tags].every((t) => (item.tags || []).includes(t))
  }

  function matchesSearch(item) {
    const q = state.search.trim().toLowerCase()
    if (!q) return true
    const hay = [item.title, item.author, item.description, ...(item.tags || [])]
      .filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  }

  /** 核心过滤管线：Tab → 分类 → 标签 → 搜索，再排序 */
  function getVisibleItems() {
    let list = ITEMS
    if (state.tab === 'subscribed') list = list.filter((i) => state.subscribed.has(i.id))
    return sortItems(list.filter((i) =>
      matchesCategory(i) && matchesTags(i) && matchesSearch(i)))
  }

  /** 统计总数（不受搜索影响，用于侧边栏计数） */
  function tabBaseItems() {
    return state.tab === 'subscribed'
      ? ITEMS.filter((i) => state.subscribed.has(i.id))
      : ITEMS
  }

  /* ---------------------------- 订阅与安装 ---------------------------- */

  const installTimers = {}

  /**
   * 是否强制演示安装：URL 带 ?hw-demo-install=1 时跳过真实下载（离线/测试/预览用）。
   * 真实安装仅当条目带 source.asset_url（GitHub Release 安装包）且非演示模式时触发。
   */
  function isDemoInstall() {
    try { return new URLSearchParams(location.search).get('hw-demo-install') === '1' } catch { return true }
  }

  /** 是否运行在 DSH 外壳的 iframe 中（可桥接宿主做真实安装） */
  function canReachHost() {
    try { return window.self !== window.top && window.parent && typeof window.parent.postMessage === 'function' } catch { return false }
  }

  /** 安装入口：local 分发源 → host API 真实安装；github/url 分发源 → 交给 Harness agent 安装；否则演示 */
  function startInstall(id) {
    if (state.installed.has(id) || state.installing.has(id)) return
    const item = ITEMS.find((i) => i.id === id)
    if (!item.source || isDemoInstall()) { simulateInstall(id); return }
    const st = item.source.type || (item.source.asset_url ? 'url' : item.source.url ? 'github' : 'local')
    if (st === 'local' || st === 'dir') {
      if (canReachHost()) installViaHost(id)
      else simulateInstall(id)
    } else if (canReachHost()) {
      // github / url：把网址交给 Harness 的 agent 去装（用户已放开权限）
      installViaAgent(id)
    } else simulateInstall(id)
  }

  /**
   * 交给 Harness agent 安装：把条目网址发给当前会话，让 agent 自行下载/校验/写入 profile。
   * 用户在对话里能看到进度与结果；本处只做提交与提示。
   */
  function installViaAgent(id) {
    const item = ITEMS.find((i) => i.id === id)
    state.installing.add(id)
    state.installPct[id] = 5
    toast(`已将「${item.title}」的安装请求发给 Harness（请看对话）…`)
    renderInstallUI(id)
    const requestId = 'hw-agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    let settled = false
    const settle = (ok, message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', onReply)
      state.installing.delete(id)
      delete state.installPct[id]
      toast(ok ? (message || '已提交给 Harness 自动安装，进度请看对话') : (message || '无法交给 Harness'), !ok)
      renderAll()
      if (!document.getElementById('view-detail').hidden) renderDetail()
    }
    const onReply = (e) => {
      const d = e.data
      if (!d || d.type !== 'hw:prompt-result' || d.requestId !== requestId) return
      settle(d.ok, d.message)
    }
    const timer = setTimeout(() => settle(false, '未收到 Harness 确认（可能没有打开会话），已取消自动安装'), 20_000)
    window.addEventListener('message', onReply)
    try {
      window.parent.postMessage({ type: 'hw:prompt-agent', requestId, payload: {
        id: item.id,
        title: item.title,
        version: item.version || '',
        url: (item.source && (item.source.url || item.source.asset_url)) || '',
        description: (item.description || '').slice(0, 300),
      } }, '*')
    } catch (err) {
      settle(false, String(err && err.message || err))
    }
  }

  /**
   * 宿主驱动安装：把条目元数据发给 DSH 外壳（client/plugin.js 桥），由 host API
   * 完成下载/校验/写 profile/pnpm install。失败或超时自动回退演示安装。
   */
  function installViaHost(id) {
    const item = ITEMS.find((i) => i.id === id)
    state.installing.add(id)
    state.installPct[id] = 10
    toast(`正在请求 DSH 安装「${item.title}」…`)
    renderInstallUI(id)
    const requestId = 'hw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    let settled = false
    const settle = (ok, message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', onReply)
      if (ok) {
        finishInstall(id, 'DSH')
        if (message) toast(message)
      } else {
        state.installing.delete(id)
        delete state.installPct[id]
        toast((message || 'DSH 安装失败') + '，已切换为演示安装')
        simulateInstall(id)
      }
    }
    const onReply = (e) => {
      const d = e.data
      if (d && d.type === 'hw:install-result' && d.requestId === requestId) settle(d.ok, d.message)
    }
    const timer = setTimeout(() => settle(false, 'DSH 安装超时'), 90_000)
    window.addEventListener('message', onReply)
    try {
      window.parent.postMessage({ type: 'hw:install', requestId, payload: {
        id: item.id, title: item.title, version: item.version,
        source: item.source || {},
      } }, '*')
    } catch (err) {
      settle(false, String(err && err.message || err))
    }
  }

  /** 卸载时同步通知宿主移除 profile 中的依赖与 patch 行（尽力而为，无需等待） */
  function hostUninstall(id) {
    if (!canReachHost()) return
    try {
      window.parent.postMessage({ type: 'hw:uninstall', requestId: 'hw-un-' + Date.now(), payload: { id } }, '*')
    } catch { /* 忽略 */ }
  }

  /**
   * 演示安装：依次推进下载/校验/写入/完成的进度动画。
   */
  function simulateInstall(id) {
    const item = ITEMS.find((i) => i.id === id)
    state.installing.add(id)
    let step = 0
    const next = () => {
      if (step >= INSTALL_STEPS.length) { finishInstall(id, '演示'); return }
      const s = INSTALL_STEPS[step++]
      state.installPct[id] = s.pct
      toast(`正在安装「${item.title}」：${s.label}`)
      renderInstallUI(id)
      installTimers[id] = setTimeout(next, s.delay)
    }
    next()
  }

  /**
   * 真实安装：从 GitHub Release 下载安装包 → sha256 完整性校验 → IndexedDB 本地存档。
   * 任一步失败都会回退到演示安装，保证「订阅→安装」流程不中断。
   */
  async function installFromGithub(id) {
    const item = ITEMS.find((i) => i.id === id)
    state.installing.add(id)
    state.installPct[id] = 5
    toast(`正在从 GitHub 下载「${item.title}」安装包…`)
    renderInstallUI(id)
    try {
      const res = await fetch(item.source.asset_url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = await res.arrayBuffer()
      state.installPct[id] = 70
      renderInstallUI(id)
      toast('下载完成，校验完整性…')

      // sha256 校验（可选，source.sha256 由发布方提供）
      let sha = ''
      if (item.source.sha256 && typeof crypto !== 'undefined' && crypto.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', buf)
        sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
        if (sha !== String(item.source.sha256).toLowerCase()) throw new Error('sha256 校验失败（文件可能被篡改）')
      }

      state.installPct[id] = 90
      renderInstallUI(id)
      await storeBundle(id, new Uint8Array(buf), item.source.asset_name || 'plugin.bundle')
      finishInstall(id, '真实')
    } catch (err) {
      cancelInstall(id)
      toast(`真实下载失败（${err.message}），已切换为演示安装`)
      simulateInstall(id)
    }
  }

  function finishInstall(id, mode = '') {
    const item = ITEMS.find((i) => i.id === id)
    state.installing.delete(id)
    delete state.installPct[id]
    state.installed.add(id)
    writeLS(LS_INSTALLED, [...state.installed])
    const note = mode === 'DSH'
      ? '，刷新页面后生效'
      : mode === '真实'
        ? '，安装包已存档'
        : '（演示安装，未真正写入 DSH）'
    toast(`「${item.title}」安装完成${mode ? '（' + mode + '安装）' : ''}${note}`)
    renderAll()
    if (!document.getElementById('view-detail').hidden) renderDetail()
  }

  function cancelInstall(id) {
    clearTimeout(installTimers[id])
    delete installTimers[id]
    state.installing.delete(id)
    delete state.installPct[id]
  }

  /** 安装包存入 IndexedDB（localStorage 容量不够放二进制） */
  function storeBundle(id, bytes, name) {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB 不可用'))
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('harness_workshop_bundles', 1)
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('bundles')) req.result.createObjectStore('bundles') }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('bundles', 'readwrite')
        tx.objectStore('bundles').put({ name, bytes, installedAt: Date.now() }, id)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(new Error('IndexedDB 写入失败')) }
      }
      req.onerror = () => reject(new Error('IndexedDB 打开失败'))
    })
  }

  /** 卸载时删除本地安装包（静默，失败无碍） */
  function deleteBundle(id) {
    if (typeof indexedDB === 'undefined') return
    try {
      const req = indexedDB.open('harness_workshop_bundles', 1)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('bundles', 'readwrite')
        tx.objectStore('bundles').delete(id)
        tx.oncomplete = () => db.close()
        tx.onerror = () => db.close()
      }
    } catch { /* 忽略 */ }
  }

  /** 安装进度只做定点更新（按钮文案/进度条/卡片徽标），不做整页重绘 */
  function renderInstallUI(id) {
    renderGrid()
    const detail = document.getElementById('view-detail')
    if (detail.hidden) return
    const btn = document.getElementById('detail-sub')
    const bar = document.getElementById('install-bar')
    if (state.installing.has(id)) {
      const pct = state.installPct[id] ?? 0
      if (btn) { btn.disabled = true; btn.textContent = `⏳ 安装中… ${pct}%` }
      if (bar) {
        bar.hidden = false
        document.getElementById('install-bar-fill').style.width = pct + '%'
        document.getElementById('install-bar-text').textContent = `正在安装 ${pct}%`
      }
    }
  }

  function toggleSubscribe(id) {
    const item = ITEMS.find((i) => i.id === id)
    const was = state.subscribed.has(id)
    if (was) {
      // 取消订阅 = 卸载（demo 模型：订阅即安装；DSH 模式下同步移除 profile 依赖与 patch 行）
      state.subscribed.delete(id)
      cancelInstall(id)
      state.installed.delete(id)
      writeLS(LS_SUB, [...state.subscribed])
      writeLS(LS_INSTALLED, [...state.installed])
      deleteBundle(id)   // 删除本地存档的安装包
      hostUninstall(id)  // 通知 DSH 宿主卸载（尽力而为）
      toast(`已取消订阅并卸载「${item.title}」`, true)
    } else {
      state.subscribed.add(id)
      writeLS(LS_SUB, [...state.subscribed])
      toast(`已订阅「${item.title}」，开始安装…`)
    }
    renderAll()
    // 若当前正停留在该条目的详情页，需同步刷新详情视图（订阅按钮/统计 chip）
    if (!document.getElementById('view-detail').hidden) renderDetail()
    // 订阅且带分发源 → 自动安装（local / github / url 均可）
    if (!was && item.source) startInstall(id)
  }

  /* ---------------------------- Toast ---------------------------- */

  let toastTimer = null
  function toast(msg, isUnsub) {
    const el = $('#toast')
    el.classList.remove('hide')
    el.innerHTML = `<span class="toast-ico">${isUnsub ? '−' : '✓'}</span><span>${esc(msg)}</span>`
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      el.classList.add('hide')
      setTimeout(() => { el.hidden = true; el.classList.remove('hide') }, 260)
    }, 2200)
  }

  /* ---------------------------- 渲染：统计条 ---------------------------- */

  function renderStats() {
    // 统计条与当前视图上下文保持一致：物品总数/最近更新/总浏览量均基于当前 Tab 的条目集合，
    // 「已订阅」为个人全局数字（与导航徽章同源）。
    const base = tabBaseItems()
    const recent = base.filter((i) => Date.now() - Number(i.update_time) <= 7 * DAY).length
    $('#stat-total').textContent = fmtNum(base.length)
    $('#stat-subscribed').textContent = fmtNum(state.subscribed.size)
    $('#stat-recent').textContent = fmtNum(recent)
    $('#stat-views').textContent = fmtNum(base.reduce((s, i) => s + (i.stats?.views || 0), 0))
    $('#sub-badge').textContent = fmtNum(state.subscribed.size)
    const syncEl = $('#stat-sync')
    if (syncEl) {
      syncEl.textContent = state.liveSyncing
        ? '同步中…'
        : state.liveSyncAt
          ? new Date(state.liveSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
          : '内嵌'
    }
  }

  /* ---------------------------- 渲染：分类树 ---------------------------- */

  function renderTree() {
    const root = $('#cat-tree')
    const counts = {}
    const base = tabBaseItems()
    for (const node of CATEGORIES) {
      counts[node.id] = 0
      for (const child of node.children || []) {
        counts[child.id] = base.filter((i) => (i.tags || []).includes(child.tag)).length
        counts[node.id] += counts[child.id]
      }
      if (node.id === 'all') counts[node.id] = base.length
    }

    const nodeHTML = (node, depth) => {
      const isOpen = state.openNodes.has(node.id)
      const hasChildren = (node.children || []).length > 0
      const selected = state.category === node.id
      const caret = hasChildren
        ? `<span class="cat-caret">▶</span>`
        : `<span class="cat-caret leaf"></span>`
      const row = `
        <li class="cat-node ${isOpen ? 'open' : ''}" data-id="${node.id}">
          <button class="cat-row ${selected ? 'selected' : ''}" data-cat="${node.id}" type="button">
            ${caret}
            <span class="cat-name">${esc(node.name)}</span>
            <span class="cat-count">${fmtNum(counts[node.id] ?? 0)}</span>
          </button>`
      let children = ''
      if (hasChildren) {
        children = `<ul class="cat-children">` +
          node.children.map((c) => nodeHTML(c, depth + 1)).join('') +
          `</ul>`
      }
      return row + children + `</li>`
    }

    root.innerHTML = CATEGORIES.map((n) => nodeHTML(n, 0)).join('')
  }

  /* ---------------------------- 渲染：标签过滤器 ---------------------------- */

  function renderTags() {
    const counts = {}
    for (const item of tabBaseItems()) {
      for (const t of item.tags || []) counts[t] = (counts[t] || 0) + 1
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
    $('#tag-filter').innerHTML = entries.map(([tag, n]) => `
      <li class="tag-item ${state.tags.has(tag) ? 'checked' : ''}" data-tag="${esc(tag)}" role="checkbox" aria-checked="${state.tags.has(tag)}">
        <span class="tag-check"></span>
        <span class="tag-label">${esc(tag)}</span>
        <span class="tag-count">${fmtNum(n)}</span>
      </li>`).join('')
  }

  /* ---------------------------- 渲染：网格视图 ---------------------------- */

  /** 每页卡片数 */
  const PAGE_SIZE = 24

  /** 渲染翻页条（页码窗口：当前页 ±2 + 首尾页） */
  function renderPagination(list) {
    const el = $('#pagination')
    if (!el) return
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    if (totalPages <= 1) { el.innerHTML = ''; el.hidden = true; return }
    el.hidden = false
    const page = Math.min(state.page, totalPages)
    const wanted = new Set([1, totalPages, page - 2, page - 1, page, page + 1, page + 2].filter((p) => p >= 1 && p <= totalPages))
    const pages = [...wanted].sort((a, b) => a - b)
    let html = `<button class="pg-btn" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="上一页">‹</button>`
    let prev = 0
    for (const p of pages) {
      if (p - prev > 1) html += '<span class="pg-ellipsis">…</span>'
      html += `<button class="pg-btn${p === page ? ' active' : ''}" data-page="${p}">${p}</button>`
      prev = p
    }
    html += `<button class="pg-btn" data-page="${page + 1}"${page >= totalPages ? ' disabled' : ''} aria-label="下一页">›</button>`
    html += `<span class="pg-info">第 ${page} / ${totalPages} 页</span>`
    el.innerHTML = html
  }

  function renderGrid() {
    const list = getVisibleItems()
    const grid = $('#item-grid')
    const empty = $('#empty-state')
    const catName = categoryNode(state.category).name
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    if (state.page > totalPages) state.page = totalPages

    $('#content-title').textContent =
      state.tab === 'subscribed' ? `您的订阅${state.category !== 'all' ? ' · ' + catName : ''}` : catName

    $('#result-count').textContent =
      `显示 ${fmtNum(list.length)} 个${state.tab === 'subscribed' ? '已订阅 ' : ''}结果`

    if (list.length === 0) {
      grid.innerHTML = ''
      empty.hidden = false
      const pg = $('#pagination')
      if (pg) { pg.innerHTML = ''; pg.hidden = true }
      if (state.tab === 'subscribed' && ITEMS.length > 0) {
        $('#empty-title').textContent = '您还没有订阅任何插件'
        $('#empty-desc').textContent = '前往「浏览」页寻找感兴趣的 Harness 扩展，点击订阅即可在此处管理。'
        $('#empty-reset').textContent = '去浏览全部插件'
      } else {
        $('#empty-title').textContent = '没有找到匹配的插件'
        $('#empty-desc').textContent = '试试调整搜索关键词、分类或标签筛选条件。'
        $('#empty-reset').textContent = '重置筛选条件'
      }
      return
    }
    empty.hidden = true
    const pageItems = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE)
    grid.innerHTML = pageItems.map(cardHTML).join('')
    renderPagination(list)
  }

  function cardHTML(item) {
    const s = item.stats || {}
    const sub = state.subscribed.has(item.id)
    const installed = state.installed.has(item.id)
    const installing = state.installing.has(item.id)
    const badge = installed
      ? '<span class="card-sub-badge installed">✓ 已安装</span>'
      : installing
        ? '<span class="card-sub-badge installing">⏳ 安装中…</span>'
        : sub
          ? '<span class="card-sub-badge">✓ 已订阅</span>'
          : ''
    return `
    <article class="item-card ${sub ? 'subscribed' : ''}" data-id="${esc(item.id)}" role="button" tabindex="0"
             aria-label="查看 ${esc(item.title)}">
      <div class="card-thumb-wrap">
        <img class="card-thumb" src="${esc(item.thumbnail)}" alt="${esc(item.title)}" loading="lazy" onerror="this.style.display='none'">
        ${badge}
      </div>
      <div class="card-body">
        <h3 class="card-title">${esc(item.title)}</h3>
        <div class="card-author">${avatarHTML(item.author, hueOf(item.author))}${esc(item.author)}</div>
        <div class="card-rating">
          ${githubStarsHTML(s.stars)}
          <span class="rating-count" title="订阅数">${fmtNum(s.subscribers)} 订阅</span>
        </div>
        <p class="card-desc">${esc(item.description || '')}</p>
        <div class="card-footer">
          <div class="card-stats">
            <span>订阅 ${fmtNum(s.subscribers)}</span>
            <span class="views">${fmtNum(s.views)} 次浏览 · ${timeAgo(item.update_time)}</span>
          </div>
          <button class="sub-btn ${sub ? 'subscribed' : ''}" data-sub="${esc(item.id)}" type="button">
            ${sub ? '<span class="sub-check">✓</span> 已订阅' : '＋ 订阅'}
          </button>
        </div>
      </div>
    </article>`
  }

  /* ---------------------------- 渲染：详情页 ---------------------------- */

  function currentDetailId() { return location.hash.replace(/^#\/item\//, '') }

  function renderDetail() {
    const id = currentDetailId()
    const item = ITEMS.find((i) => i.id === id)
    const browse = $('#view-browse')
    const detail = $('#view-detail')
    if (!item) { showBrowse(); return }

    browse.hidden = true
    detail.hidden = false
    const s = item.stats || {}
    const sub = state.subscribed.has(item.id)
    const installed = state.installed.has(item.id)
    const installing = state.installing.has(item.id)
    const src = (item.source && item.source.url) || ''
    const ver = item.version || ''
    const comments = allComments(item)
    const changelog = item.changelog || []

    const changelogHTML = changelog.length === 0
      ? `<p style="color:var(--text-muted);font-size:13px;">该插件暂无更新日志。</p>`
      : `<ul class="changelog-list">` + changelog.map((c) => `
          <li class="changelog-item">
            <div class="changelog-ver"><span class="ver-tag">v${esc(c.version)}</span>${esc(c.version)}</div>
            <div class="changelog-date">${fmtDate(c.date)}</div>
            <ul>${(c.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
          </li>`).join('') + `</ul>`

    const tagsHTML = (item.tags || []).map((t) =>
      `<button class="detail-tag" data-tag-click="${esc(t)}" type="button">${esc(t)}</button>`).join('')

    detail.innerHTML = `
      <button class="detail-back" id="detail-back" type="button">← 返回创意工坊</button>
      <div class="detail-hero">
        <img class="detail-cover" src="${esc(item.thumbnail)}" alt="${esc(item.title)}" onerror="this.style.display='none'">
        <div>
          <h1 class="detail-title">${esc(item.title)}</h1>
          <div class="detail-meta">
            <span>作者：<a class="author" href="#" data-author="${esc(item.author)}">${esc(item.author)}</a></span>
            ${ver ? `<span class="dot">•</span><span>v${esc(ver)}</span>` : ''}
            <span class="dot">•</span>
            <span>${timeAgo(item.update_time)}（${fmtDate(item.update_time)}）</span>
          </div>
          <div class="detail-stats">
            <div class="stat-chip"><b>${fmtNum(s.subscribers)}</b><span>订阅</span></div>
            <div class="stat-chip rating"><b>${fmtNum(s.stars || 0)}</b><span>GitHub 星标</span></div>
            <div class="stat-chip"><b>${fmtNum(s.views)}</b><span>浏览</span></div>
          </div>
          <div class="detail-actions">
            <button class="detail-sub-btn ${sub ? 'subscribed' : ''}" id="detail-sub" data-sub="${esc(item.id)}" type="button" ${installing ? 'disabled' : ''}>
              ${installing ? `⏳ 安装中… ${state.installPct[item.id] ?? 0}%`
                : installed ? '✓ 已订阅 · 已安装（点击卸载）'
                : sub ? '✓ 已订阅（点击取消）'
                : '＋ 订阅并安装'}
            </button>
            ${src ? `<a class="detail-gh" href="${esc(src)}" target="_blank" rel="noopener noreferrer"
                     aria-label="在 GitHub 上查看 ${esc(item.title)} 源码" title="跳转 GitHub 源码页">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2 0 0 .7-.2 2.2.8.6-.2 1.3-.3 2-.3s1.4.1 2 .3c1.5-1 2.2-.8 2.2-.8.5 1 .2 1.8.1 2 .5.6.8 1.3.8 2.2 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.6v2.2c0 .2.1.5.5.4C13.7 14.5 16 11.5 16 8c0-4.4-3.6-8-8-8z"/></svg>
              GitHub 源码 ↗</a>` : ''}
            <button class="detail-share" id="detail-share" type="button">分享链接</button>
          </div>
          <div class="install-bar" id="install-bar" hidden role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="install-bar-fill" id="install-bar-fill"></div>
            <span class="install-bar-text" id="install-bar-text">正在安装 0%</span>
          </div>
          <div class="detail-tags">${tagsHTML}</div>
        </div>
      </div>

      <div class="detail-body">
        <div class="detail-main">
          <section class="detail-card">
            <h3>简介</h3>
            <div class="detail-desc">${parseDesc(item.description || '')}</div>
          </section>

          <section class="detail-card">
            <h3>更新日志 <small>${changelog.length} 条</small></h3>
            ${changelogHTML}
          </section>

          <section class="detail-card">
            <h3>评论 <small id="comment-count">${comments.length} 条</small></h3>
            <div class="comment-form">
              ${avatarHTML('我', '#1a9fff')}
              <textarea class="comment-input" id="comment-input" placeholder="写下你的使用体验…（Enter 提交，Shift+Enter 换行）" rows="2"></textarea>
              <button class="comment-submit" id="comment-submit" type="button">发表评论</button>
            </div>
            <ul class="comment-list" id="comment-list">
              ${comments.map(commentHTML).join('')}
            </ul>
          </section>
        </div>

        <aside class="detail-side">
          <div class="side-card">
            <h4>开发者</h4>
            <div class="side-dev">${avatarHTML(item.author, hueOf(item.author))}${esc(item.author)}</div>
          </div>
          <div class="side-card">
            <h4>标签</h4>
            <div class="side-tags">${(item.tags || []).map((t) => `<span class="side-tag">${esc(t)}</span>`).join('')}</div>
          </div>
          <div class="side-card">
            <h4>统计信息</h4>
            <div class="side-row"><span class="k">订阅数</span><span class="v green">${fmtNum(s.subscribers)}</span></div>
            ${ver ? `<div class="side-row"><span class="k">版本</span><span class="v">v${esc(ver)}</span></div>` : ''}
            <div class="side-row"><span class="k">GitHub 星标</span><span class="v gold">${fmtNum(s.stars || 0)}</span></div>
            <div class="side-row"><span class="k">浏览量</span><span class="v">${fmtNum(s.views)}</span></div>
            <div class="side-row"><span class="k">最后更新</span><span class="v">${fmtDate(item.update_time)}</span></div>
            <div class="side-row"><span class="k">兼容 DSH</span><span class="v">${esc((item.compat && item.compat.dsh) || '≥ 0.1.0-rc.5')}</span></div>
          </div>
        </aside>
      </div>`

    bindDetailEvents(item)

    // 焦点管理：从浏览视图进入详情时聚焦「返回」按钮（详情页内重渲染不抢焦点）
    const fromBrowse = state.view !== 'detail'
    state.view = 'detail'
    if (fromBrowse && state.detailFrom) $('#detail-back').focus()
  }

  /** 详情页内的事件绑定（元素是动态生成的，需在渲染后挂接） */
  function bindDetailEvents(item) {
    $('#detail-back').addEventListener('click', () => {
      // 返回时同步 URL 到浏览页（与 Esc 行为一致），由 hashchange 路由完成切换与焦点恢复
      if (location.hash === '#/browse') showBrowse()
      else location.hash = '#/browse'
    })
    $('#detail-sub').addEventListener('click', () => toggleSubscribe(item.id))

    $('#detail-share').addEventListener('click', async () => {
      const url = location.origin + location.pathname + '#/item/' + item.id
      try {
        await navigator.clipboard.writeText(url)
        toast('详情页链接已复制到剪贴板')
      } catch (_) {
        toast(url)
      }
    })

    document.querySelectorAll('[data-tag-click]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.tags.add(btn.dataset.tagClick)
        state.page = 1
        state.detailFrom = null
        state.pendingTagFocus = btn.dataset.tagClick
        if (location.hash === '#/browse') showBrowse()
        else location.hash = '#/browse'   // 同步 URL，由 hashchange 路由完成切换与焦点恢复
      })
    })

    document.querySelectorAll('[data-author]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault()
        const q = a.dataset.author
        state.search = q
        state.page = 1
        $('#search-input').value = q
        state.detailFrom = null
        state.pendingSearchFocus = true
        if (location.hash === '#/browse') showBrowse()
        else location.hash = '#/browse'   // 同步 URL，由 hashchange 路由完成切换与焦点恢复
      })
    })

    const input = $('#comment-input')
    const submit = $('#comment-submit')
    submit.addEventListener('click', () => submitComment(item))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        submitComment(item)
      }
    })

    document.querySelectorAll('[data-like]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.like
        if (state.likes.has(key)) { state.likes.delete(key); btn.classList.remove('liked') }
        else { state.likes.add(key); btn.classList.add('liked') }
        writeLS(LS_LIKES, [...state.likes])
      })
    })
  }

  /** 评论 = 内置评论 + 本地新增评论（本地评论优先展示） */
  function allComments(item) {
    return [...(state.extraComments[item.id] || []), ...(item.comments || [])]
  }

  function commentHTML(c, extra) {
    const key = (extra ? 'x:' : 'i:') + (c.uid || c.author) + ':' + c.time
    const liked = state.likes.has(key)
    return `
    <li class="comment-item">
      ${avatarHTML(c.author, c.avatar || hueOf(c.author))}
      <div class="comment-body">
        <div class="comment-head">
          <span class="comment-author">${esc(c.author)}</span>
          ${extra ? '<span class="comment-me">我</span>' : ''}
          <span class="comment-time">${timeAgo(c.time)} · ${fmtDate(c.time)}</span>
        </div>
        <p class="comment-content">${esc(c.content)}</p>
        <button class="comment-like ${liked ? 'liked' : ''}" data-like="${key}" type="button">👍 赞 (${fmtNum((c.likes || 0) + (liked ? 1 : 0))})</button>
      </div>
    </li>`
  }

  function submitComment(item) {
    const input = $('#comment-input')
    const text = input.value.trim()
    if (!text) return
    const c = {
      uid: 'me-' + Date.now(),
      author: '我',
      avatar: '#1a9fff',
      time: Date.now(),
      content: text,
      likes: 0,
    }
    state.extraComments[item.id] = [c, ...(state.extraComments[item.id] || [])]
    writeLS(LS_COMMENTS, state.extraComments)
    input.value = ''
    renderDetail()
    toast('评论已发布')
  }

  /* ---------------------------- 路由 ---------------------------- */

  function route() {
    const hash = location.hash
    if (/^#\/item\//.test(hash)) { renderDetail(); return }
    const newTab = hash === '#/subscribed' ? 'subscribed' : 'browse'
    if (newTab !== state.tab) state.page = 1
    state.tab = newTab
    showBrowse()
  }

  function showBrowse() {
    $('#view-detail').hidden = true
    const browse = $('#view-browse')
    browse.hidden = false
    document.querySelectorAll('.tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === state.tab))
    state.view = 'browse'
    renderAll()
    // 焦点管理（按优先级）：详情返回 → 卡片；详情页点标签 → 对应筛选项；详情页点作者 → 搜索框
    const q = (s) => String(s).replace(/"/g, '\\"')
    if (state.detailFrom) {
      const card = document.querySelector(`.item-card[data-id="${q(state.detailFrom)}"]`)
      state.detailFrom = null
      if (card) card.focus()
    } else if (state.pendingTagFocus) {
      const tag = state.pendingTagFocus
      state.pendingTagFocus = null
      const el = document.querySelector(`[data-tag="${q(tag)}"]`)
      if (el) el.focus()
      else $('#search-input').focus()
    } else if (state.pendingSearchFocus) {
      state.pendingSearchFocus = false
      const input = $('#search-input')
      input.focus()
      input.select()
    }
  }

  function renderAll() {
    renderStats()
    renderTree()
    renderTags()
    renderGrid()
  }

  /* ---------------------------- 事件绑定 ---------------------------- */

  function bindEvents() {
    // 排序下拉（Listbox 键盘导航：↑/↓ 移动、Home/End 跳转、Enter/Space 选中、Esc 关闭）
    const dropdown = $('#sort-dropdown')
    const trigger = $('#sort-trigger')
    const menu = $('#sort-menu')
    const opts = [...menu.querySelectorAll('li[data-sort]')]
    opts.forEach((o, i) => { o.id = o.id || `sort-opt-${o.dataset.sort}` })
    let activeIdx = 0

    const setActive = (i) => {
      activeIdx = (i + opts.length) % opts.length
      opts.forEach((o, idx) => {
        o.classList.toggle('active', idx === activeIdx)
        // aria-selected 仅表示「已选中排序项」；键盘当前指向用 .active 类高亮
        o.setAttribute('aria-selected', String(o.dataset.sort === state.sort))
      })
      trigger.setAttribute('aria-activedescendant', opts[activeIdx].id)
      opts[activeIdx].scrollIntoView?.({ block: 'nearest' })
    }

    const selectActive = () => {
      const li = opts[activeIdx]
      if (!li) return
      state.sort = li.dataset.sort
      state.page = 1
      open(false)
      savePrefs()
      renderGrid()
    }

    const open = (v) => {
      trigger.setAttribute('aria-expanded', String(v))
      menu.hidden = !v
      if (v) {
        const cur = opts.findIndex((o) => o.dataset.sort === state.sort)
        setActive(cur >= 0 ? cur : 0)
      }
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation()
      open(menu.hidden)
    })
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (menu.hidden) open(true)
        else setActive(e.key === 'ArrowDown' ? activeIdx + 1 : activeIdx - 1)
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (menu.hidden) open(true)
        else selectActive()
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        if (!menu.hidden) setActive(e.key === 'Home' ? 0 : opts.length - 1)
      }
    })
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(e.key === 'ArrowDown' ? activeIdx + 1 : activeIdx - 1) }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); setActive(e.key === 'Home' ? 0 : opts.length - 1) }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectActive() }
      else if (e.key === 'Tab') { open(false) }
    })
    opts.forEach((o, i) => o.addEventListener('mouseenter', () => setActive(i)))
    opts.forEach((li) => {
      li.addEventListener('click', () => {
        state.sort = li.dataset.sort
        state.page = 1
        open(false)
        savePrefs()
        renderGrid()
      })
    })
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target)) open(false)
    })
    // Tab 切换：直接处理点击，不依赖 srcdoc iframe 内 <a href="#..."> 的 hash 导航
    // （about:srcdoc 中锚点 hash 跳转/外壳点击拦截可能导致 hashchange 不触发，点了没反应）
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault()
        const target = tab.dataset.tab === 'subscribed' ? 'subscribed' : 'browse'
        if (target !== state.tab) state.page = 1
        state.tab = target
        try { location.hash = state.tab === 'subscribed' ? '#/subscribed' : '#/browse' } catch { /* srcdoc 限制，忽略 */ }
        showBrowse()
      })
    })
    // 翻页（事件委托）
    const pagination = $('#pagination')
    if (pagination) {
      pagination.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-page]')
        if (!btn || btn.disabled) return
        state.page = Number(btn.dataset.page)
        renderGrid()
        const grid = $('#item-grid')
        if (grid) grid.scrollIntoView({ block: 'start', behavior: 'smooth' })
      })
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      open(false)
      // 详情页按 Esc 返回浏览视图（同步 URL；焦点随 showBrowse 恢复）
      if (state.view === 'detail' && !$('#view-detail').hidden) {
        location.hash = '#/browse'
      }
    })

    // 搜索
    let debounce = null
    $('#search-input').addEventListener('input', (e) => {
      clearTimeout(debounce)
      $('#search-clear').hidden = e.target.value === ''
      debounce = setTimeout(() => {
        state.search = e.target.value
        state.page = 1
        renderGrid()
      }, 120)
    })
    $('#search-clear').addEventListener('click', () => {
      const input = $('#search-input')
      input.value = ''
      state.search = ''
      state.page = 1
      $('#search-clear').hidden = true
      renderGrid()
      input.focus()
    })

    // 分类树（事件委托）：先判断是否点击展开箭头，再处理节点选中
    $('#cat-tree').addEventListener('click', (e) => {
      const caret = e.target.closest('.cat-caret')
      if (caret && !caret.classList.contains('leaf')) {
        const node = e.target.closest('.cat-node')
        const id = node.dataset.id
        if (state.openNodes.has(id)) state.openNodes.delete(id)
        else state.openNodes.add(id)
        renderTree()
        return
      }
      const row = e.target.closest('[data-cat]')
      if (!row) return
      const id = row.dataset.cat
      if (state.category === id) return
      state.category = id
      state.page = 1
      savePrefs()
      renderTree()
      renderGrid()
    })

    // 标签过滤器（事件委托）
    $('#tag-filter').addEventListener('click', (e) => {
      const item = e.target.closest('[data-tag]')
      if (!item) return
      const tag = item.dataset.tag
      if (state.tags.has(tag)) state.tags.delete(tag)
      else state.tags.add(tag)
      state.page = 1
      renderTags()
      renderGrid()
    })

    // 重置筛选
    const reset = () => {
      state.category = 'all'
      state.tags.clear()
      state.search = ''
      state.page = 1
      $('#search-input').value = ''
      $('#search-clear').hidden = true
      savePrefs()
      renderAll()
    }
    $('#reset-filters').addEventListener('click', reset)
    $('#empty-reset').addEventListener('click', () => {
      if (state.tab === 'subscribed') { location.hash = '#/browse'; return }
      reset()
    })

    // 卡片：点击进入详情 / 订阅按钮独立响应（事件委托）
    $('#item-grid').addEventListener('click', (e) => {
      const subBtn = e.target.closest('[data-sub]')
      if (subBtn) {
        e.stopPropagation()
        toggleSubscribe(subBtn.dataset.sub)
        return
      }
      const card = e.target.closest('[data-id]')
      if (card) { state.detailFrom = card.dataset.id; location.hash = '#/item/' + card.dataset.id }
    })
    $('#item-grid').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        // 订阅按钮自身的回车/空格由按钮 click 处理，避免误触导航
        if (e.target.closest('[data-sub]')) return
        const card = e.target.closest('[data-id]')
        if (card) {
          e.preventDefault()
          state.detailFrom = card.dataset.id
          location.hash = '#/item/' + card.dataset.id
        }
      }
    })

    window.addEventListener('hashchange', route)
  }

  /* ---------------------------- 启动 ---------------------------- */

  async function init() {
    await loadData()
    bindEvents()
    route()
    renderAll()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
