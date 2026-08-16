// Harness 创意工坊 — node 半边（host）。
// 职责：
//   1. 让插件出现在 host 的 cordis.yml / Loader 树中（roster 行 name: harness-workshop 需要包根入口）；
//   2. 注册「订阅 → 真实安装」API 路由（/api/harness-workshop/*），由浏览器半边桥接调用。
// 浏览器半边经 exports["./client"] 出货，通过 package.json 的 dsh.client 清单被发现。
//
// 安全说明：路由仅绑定在 127.0.0.1（web profile 默认 loopback）。安装目标包必须声明
// dsh.client / dsh.bundle 清单，下载仅允许 https，条目 id 有严格白名单。生产部署若绑定
// 0.0.0.0（当前 CLI 不支持）需再加来源白名单与签名校验。

const { install, uninstall, resolveProfileDir } = require('./host-install.js')
const workshopData = require('./workshop-data.js')

const API_PREFIX = '/api/harness-workshop'

/** 读取请求体（上限 1 MiB）。 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 通用处理：解析 JSON 请求体 → 执行业务 → JSON 应答；错误 → 4xx/5xx + ok:false。 */
function handle(fn) {
  return async (req, res) => {
    let input = null
    try {
      if (req.method !== 'POST') return json(res, 405, { ok: false, message: `Method ${req.method} not allowed` })
      const raw = await readBody(req)
      input = raw ? JSON.parse(raw) : {}
    } catch (err) {
      return json(res, 400, { ok: false, message: `请求解析失败: ${err.message}` })
    }
    try {
      const result = await fn(input)
      json(res, 200, { ok: true, ...result })
    } catch (err) {
      json(res, 500, { ok: false, message: String(err && err.message || err) })
    }
  }
}

function apply(ctx) {
  // 定时全量同步（默认每 6 小时）；ctx 销毁时清理定时器。
  const disposer = workshopData.schedule()
  ctx.effect(() => disposer)

  // 等 webserver 就绪后再注册路由；无 webserver 的 profile（如 headless）不注册，插件其余部分不受影响。
  ctx.inject(['webServer'], (srvCtx) => {
    srvCtx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/install`,
      handler: handle((input) => install(ctx, input)),
    })
    srvCtx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/uninstall`,
      handler: handle((input) => uninstall(ctx, input)),
    })
    srvCtx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: handle(() => {
        let profileDir = null
        try { profileDir = resolveProfileDir(ctx) } catch { /* 未就绪 */ }
        return { available: true, profileDir, version: '1.2.0' }
      }),
    })
    // 工坊数据：GET 返回当前缓存（?refresh=1 或缓存过期时后台触发同步）。
    srvCtx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/items`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, message: `Method ${req.method} not allowed` })
        try {
          const force = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1'
          const data = workshopData.getItems({ force })
          json(res, 200, { ok: true, ...data })
        } catch (err) {
          json(res, 500, { ok: false, message: String(err && err.message || err) })
        }
      },
    })
    // 手动触发一次后台同步，立即返回当前状态（客户端轮询 items 等待 syncedAt 前进）。
    srvCtx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/refresh`,
      handler: handle(() => {
        workshopData.getItems({ force: true })
        return { syncing: true, message: '已触发 GitHub 同步，稍后刷新工坊可见新插件' }
      }),
    })
  })
}

module.exports = { apply }
