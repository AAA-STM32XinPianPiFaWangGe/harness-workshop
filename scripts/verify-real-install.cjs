/**
 * verify-real-install.cjs — 「订阅 → 真实下载安装」链路的本地端到端验证。
 *
 * 背景：真实安装路径（js/workshop.js 的 installFromGithub）只有在条目带 source.asset_url
 * 时才会触发，而当前 mock-data 里的条目没有该字段（需 npm run refresh 拉取 Release 后才有）。
 * 本脚本用本地文件模拟一个"带安装包的插件"，证明：
 *   1) 点击订阅会真的发起对安装包的 HTTP 下载请求；
 *   2) 下载后进入 sha256 完整性校验阶段；
 *   3) jsdom 无 IndexedDB，按设计回退为演示安装收尾（真实浏览器会先存入 IndexedDB）。
 *
 * 前置：npm run serve 已启动；无需外网。
 * 用法：node scripts/verify-real-install.cjs
 * 对照实验（校验拒绝路径）：VERIFY_BAD_SHA=1 node scripts/verify-real-install.cjs
 */
const { JSDOM } = require('../node_modules/jsdom')
const { createHash, webcrypto } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const BASE = 'http://127.0.0.1:8357/'
const ASSET_URL = BASE + 'test-assets/hello-plugin.js'
const sha256 = createHash('sha256').update(readFileSync(join(ROOT, 'test-assets/hello-plugin.js'))).digest('hex')
// 对照实验：VERIFY_BAD_SHA=1 时声明错误的 sha256，预期校验环节拒绝（toast 提示篡改）
const BAD_SHA = process.env.VERIFY_BAD_SHA === '1'
const declaredSha = BAD_SHA ? '0'.repeat(64) : sha256

const testItem = {
  id: 'local-install-demo',
  title: '本地真实下载演示',
  author: 'verification',
  stats: { subscribers: 0, rating: 0, views: 0 },
  update_time: Date.now(),
  tags: ['效率工具'],
  thumbnail: '',
  source: {
    type: 'url',
    url: BASE,
    install: 'github',
    asset_url: ASSET_URL,
    asset_name: 'hello-plugin.js',
    sha256: declaredSha,
  },
  description: '验证「订阅 → 真实下载 → sha256 校验」链路。',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const fetched = []
  const dom = await JSDOM.fromURL(BASE + '#/browse', {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // 补齐 jsdom 缺失的 fetch / crypto.subtle（用 Node 实现），并拦截数据文件注入测试条目
      Object.defineProperty(window, 'fetch', {
        value: (u, o) => {
          const url = String(u)
          fetched.push(url)
          if (url.includes('workshop_items.json')) {
            return Promise.resolve({
              ok: true,
              json: async () => ({ generated_at: Date.now(), note: 'verification', items: [testItem] }),
            })
          }
          return fetch(new URL(url, window.location.href), o)
        },
        configurable: true,
      })
      if (!(window.crypto && window.crypto.subtle)) {
        Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true })
      }
    },
  })
  const doc = dom.window.document
  await sleep(900) // 等页面初始化（数据已注入）

  dom.window.location.hash = '#/item/local-install-demo'
  await sleep(400)
  const subBtn = doc.querySelector('#detail-sub')
  console.log('详情页订阅按钮文案:', subBtn && subBtn.textContent.trim())

  // 先挂 MutationObserver 再点击，逐条捕获 toast
  const toastLog = []
  const toastEl = doc.querySelector('#toast')
  const mo = new dom.window.MutationObserver(() => {
    const text = toastEl.textContent.trim()
    if (toastLog[toastLog.length - 1] !== text) toastLog.push(text)
  })
  mo.observe(toastEl, { childList: true, subtree: true, characterData: true })

  subBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(3500) // 等真实路径 + 回退演示安装全部走完
  mo.disconnect()

  const installed = JSON.parse(dom.window.localStorage.getItem('harness_workshop_installed_list') || '[]')
  const assetFetched = fetched.filter((u) => u.includes('test-assets'))

  console.log('\n===== 验证结果（' + (BAD_SHA ? '错误 sha256' : '正确 sha256') + '）=====')
  console.log('① 是否发起对安装包的下载请求:', assetFetched.length > 0 ? '是 ✅  ' + assetFetched[0] : '否 ❌')
  console.log('② 声明 sha256（' + (BAD_SHA ? '故意错误' : '正确') + '）:', declaredSha.slice(0, 16) + '…')
  console.log('③ 订阅后 toast 流程（DOM 级捕获）:')
  toastLog.forEach((t) => console.log('    ·', t))
  console.log('④ 最终已安装列表:', installed.includes('local-install-demo') ? '包含该插件 ✅' : '不包含该插件')
  console.log('\n（说明：jsdom 无 IndexedDB，按设计在「下载+校验」成功后回退演示安装收尾；')
  console.log('  真实浏览器中会先存入 IndexedDB 再标记已安装；')
  console.log('  BAD_SHA 模式应看到「sha256 校验失败（文件可能被篡改）」提示。）')
  dom.window.close()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
