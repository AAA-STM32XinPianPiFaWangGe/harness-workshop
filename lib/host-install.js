/**
 * host-install.js — Harness 创意工坊「订阅 → 真实安装」宿主引擎（node 半边）。
 *
 * 职责：把创意工坊条目真正安装进当前 DSH profile：
 *   1. 解析分发源（local 目录 / github 仓库 tarball / url 安装包 .tgz）
 *   2. 校验：sha256（可选）、package.json 必须声明 dsh.client 或 dsh.bundle
 *   3. 把包复制进 profile 的 workshop-packages/<id> 托管目录
 *   4. 写 profile package.json 的 dependencies（link: 依赖）
 *   5. 在 cordis.patch.yml 追加/移除本插件托管的 insert 行（带 # hw-installed: 标记）
 *   6. 在 profile 目录执行 pnpm install（建立 node_modules 链接）
 *
 * 注：cordis.patch.yml 的变更由 DSH 的 watchUserPatches 热重组合，新行挂载后
 * dsh-client-modules 增量扫描会把它纳入浏览器启动图——浏览器刷新页面即可生效。
 * 本模块刻意不依赖 @deepseek-ai/dsh-app-boot（保持零依赖、CJS、可独立单测）。
 */

const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

/** cordis.patch.yml 中由本插件托管的行标记（卸载时按此定位删除）。 */
const PATCH_MARKER = '# hw-installed:'
/** 托管安装包的目录名（profile 下）。 */
const PACKAGES_DIR = 'workshop-packages'
/** 下载大小上限：50 MiB。 */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
/** pnpm install 超时：180s。 */
const PNPM_TIMEOUT_MS = 180_000

/* ------------------------------ 基础工具 ------------------------------ */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

/** 依赖键必须是合法 npm 包名片段。 */
function safePackageName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
    throw new Error(`非法包名: ${JSON.stringify(name)}`)
  }
  return name
}

/** 行 id 仅作 patch 行标识，允许大小写字母数字与 - _ . */
function safeRowId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`非法条目 id: ${JSON.stringify(id)}`)
  }
  return id
}

function resolveDshHome() {
  return process.env.DSH_HOME && path.isAbsolute(process.env.DSH_HOME)
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

/** 定位当前运行的 profile 目录：优先 Loader baseUrl，回退为“包含 harness-workshop 依赖”的 profile。 */
function resolveProfileDir(ctx) {
  try {
    const base = ctx.get('loader')?.config?.baseUrl
    if (base) {
      const p = base.startsWith('file:') ? new URL(base).pathname.replace(/^\/([A-Za-z]:)/, '$1') : base
      const dir = path.resolve(p)
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    }
  } catch { /* 继续回退 */ }
  const profiles = path.join(resolveDshHome(), 'profiles')
  if (fs.existsSync(profiles)) {
    for (const name of fs.readdirSync(profiles)) {
      const dir = path.join(profiles, name)
      const pkgPath = path.join(dir, 'package.json')
      if (!fs.existsSync(pkgPath)) continue
      try {
        const m = readJson(pkgPath)
        if (m.dependencies && typeof m.dependencies['harness-workshop'] === 'string') return dir
      } catch { /* 下一个 */ }
      if (fs.existsSync(path.join(dir, 'node_modules', 'harness-workshop'))) return dir
    }
  }
  throw new Error('无法定位当前 DSH profile 目录（Loader baseUrl 缺失且未找到含 harness-workshop 的 profile）')
}

/* ------------------------------ 分发源解析 ------------------------------ */

function parseGithubUrl(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') }
  } catch {
    return null
  }
}

/** 解析分发源 → 返回 { srcDir }（包源码目录）。tarball 先解包到临时目录。 */
async function resolveSourceDir(source) {
  if (!source || typeof source !== 'object') throw new Error('缺少分发源 source')
  const type = source.type || (source.asset_url ? 'url' : source.url ? 'github' : 'local')

  if (type === 'local') {
    if (typeof source.path !== 'string') throw new Error('local 分发源缺少 path')
    const dir = path.resolve(source.path)
    if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error(`本地包目录缺少 package.json: ${dir}`)
    return { srcDir: dir, temp: null }
  }

  if (type === 'url' || type === 'github') {
    let downloadUrl = null
    if (type === 'url') {
      downloadUrl = source.asset_url || source.url
    } else {
      const gh = parseGithubUrl(source.url)
      if (!gh) throw new Error(`无法解析 GitHub 仓库地址: ${source.url}`)
      downloadUrl = `https://codeload.github.com/${gh.owner}/${gh.repo}/tar.gz/HEAD`
    }
    const u = new URL(downloadUrl)
    if (u.protocol !== 'https:') throw new Error('仅允许 https 分发源')
    const buf = await fetchDownload(downloadUrl, source.sha256)
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-install-'))
    const pkgRoot = extractTarball(buf, temp)
    return { srcDir: pkgRoot, temp }
  }

  throw new Error(`不支持的分发源类型: ${type}`)
}

async function fetchDownload(url, sha256) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error('安装包超过 50 MiB 上限')
  if (sha256) {
    const got = createHash('sha256').update(buf).digest('hex')
    if (got !== String(sha256).toLowerCase()) throw new Error('sha256 校验失败（文件可能被篡改）')
  }
  return buf
}

/** 解包 tar.gz（ustar/GNU 长名），返回含 package.json 的包根目录。 */
function extractTarball(buf, destDir) {
  const tar = zlib.gunzipSync(buf)
  let offset = 0
  let rootDir = null
  const mkdirp = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }) }

  const readEntryName = () => {
    if (offset + 512 > tar.length) return null
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) return null
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (type === 'L') {
      const long = tar.subarray(offset + 512, offset + 512 + size).toString('utf8').replace(/\0.*$/, '')
      offset += 512 + Math.ceil(size / 512) * 512
      const h2 = tar.subarray(offset, offset + 512)
      const size2 = parseInt(h2.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8) || 0
      name = long
      offset += 512
      return { name, size: size2, type: String.fromCharCode(h2[156] || 48) }
    }
    offset += 512
    return { name, size, type }
  }

  const safeJoin = (base, name) => {
    const clean = name.replace(/^\.\/+/, '')
    const target = path.resolve(base, clean)
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`tar 条目路径越界: ${name}`)
    return target
  }

  for (;;) {
    const entry = readEntryName()
    if (entry === null) break
    const data = tar.subarray(offset, offset + entry.size)
    offset += Math.ceil(entry.size / 512) * 512
    if (entry.type === 'x' || entry.type === 'g') continue // pax 头：跳过
    if (entry.type === '5' || entry.name.endsWith('/')) { mkdirp(safeJoin(destDir, entry.name)); continue }
    if (entry.type !== '0' && entry.type !== '') continue
    const target = safeJoin(destDir, entry.name)
    mkdirp(path.dirname(target))
    fs.writeFileSync(target, data)
    const first = entry.name.split('/')[0]
    if (rootDir === null) rootDir = first
    else if (rootDir !== first) rootDir = '.' // 多顶层目录 → 用解压根
  }
  const root = path.resolve(destDir, rootDir === null ? '' : rootDir)
  if (!fs.existsSync(path.join(root, 'package.json'))) throw new Error('安装包不是有效 npm 包（缺少 package.json）')
  return root
}

/* ------------------------------ 包校验 ------------------------------ */

/** 校验包是可安装的 DSH 插件，返回 { pkgName, manifest }。 */
function validatePackage(pkgDir) {
  const pkgPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgPath)) throw new Error('不是有效 DSH 插件包（缺少 package.json）')
  const manifest = readJson(pkgPath)
  if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('包缺少 name 字段')
  safePackageName(manifest.name)
  const dsh = manifest.dsh
  const isPlugin = dsh && (dsh.client || (dsh.bundle && typeof dsh.bundle === 'object'))
  if (!isPlugin) throw new Error(`「${manifest.name}」不是可安装的 DSH 插件（package.json 缺少 dsh.client / dsh.bundle 清单）`)
  return { pkgName: manifest.name, manifest }
}

/* ------------------------------ profile 编辑 ------------------------------ */

function profilePaths(profileDir) {
  return {
    manifestPath: path.join(profileDir, 'package.json'),
    patchPath: path.join(profileDir, 'cordis.patch.yml'),
    packagesRoot: path.join(profileDir, PACKAGES_DIR),
  }
}

/** 把包目录复制进托管目录（排除 node_modules/.git/缓存）。 */
function stagePackage(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true })
  fs.mkdirSync(destDir, { recursive: true })
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (p) => {
      const base = path.basename(p)
      return base !== 'node_modules' && base !== '.git' && base !== '.DS_Store'
    },
  })
}

function addDependency(manifestPath, pkgName, pkgDir) {
  const manifest = readJson(manifestPath)
  manifest.dependencies = manifest.dependencies || {}
  if (manifest.dependencies[pkgName] !== undefined) {
    throw new Error(`依赖已存在: ${pkgName}（${manifest.dependencies[pkgName]}）`)
  }
  manifest.dependencies[pkgName] = 'link:' + pkgDir.replace(/\\/g, '/')
  writeJson(manifestPath, manifest)
}

function removeDependency(manifestPath, pkgName) {
  const manifest = readJson(manifestPath)
  if (manifest.dependencies && manifest.dependencies[pkgName] !== undefined) {
    delete manifest.dependencies[pkgName]
    writeJson(manifestPath, manifest)
  }
}

/** 在 cordis.patch.yml 末尾追加托管行；已存在则 no-op。 */
function appendPatchRow(patchPath, rowId, pkgName) {
  let text = ''
  if (fs.existsSync(patchPath)) text = fs.readFileSync(patchPath, 'utf8')
  if (text.includes(`${PATCH_MARKER} ${rowId}\n`)) return false
  const block = `\n${PATCH_MARKER} ${rowId}\n- insert:\n    - id: ${rowId}\n      name: ${pkgName}\n`
  fs.writeFileSync(patchPath, text + block, 'utf8')
  return true
}

/** 移除托管行块（标记注释 + 紧随的 insert 块）。 */
function removePatchRow(patchPath, rowId) {
  if (!fs.existsSync(patchPath)) return
  const lines = fs.readFileSync(patchPath, 'utf8').split('\n')
  const marker = `${PATCH_MARKER} ${rowId}`
  const out = []
  let skipping = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!skipping && line.trim() === marker) { skipping = true; continue }
    if (skipping) {
      // 块内容：本块顶层的 - insert: 行、其下的缩进行与空行，全部跳过
      if (line.trim().startsWith('- ') || /^[ \t]/.test(line) || line.trim() === '') continue
      // 遇到下一个顶层注释/条目 → 块结束
      skipping = false
      out.push(line)
      continue
    }
    out.push(line)
  }
  fs.writeFileSync(patchPath, out.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8')
}

/** 在 profile 目录执行 pnpm install（建立 node_modules 链接 / 清除多余链接）。 */
function runPnpmInstall(profileDir) {
  const isWin = process.platform === 'win32'
  const run = (cmd, args, opts) => spawnSync(cmd, args, { cwd: profileDir, encoding: 'utf8', timeout: PNPM_TIMEOUT_MS, ...opts })
  // Windows 上 pnpm 是 .cmd shim，Node 的 spawnSync 直启 .cmd 会 EINVAL，必须经 shell。
  let r = run('pnpm', ['install'], { stdio: ['ignore', 'pipe', 'pipe'], shell: isWin })
  if (r.error && (r.error.code === 'ENOENT' || r.error.code === 'EINVAL')) {
    r = run('pnpm', ['install'], { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  }
  if (r.error || r.status !== 0) {
    const tail = (r.stderr || r.stdout || '').toString().split('\n').slice(-12).join('\n')
    throw new Error(`pnpm install 失败（${r.error ? r.error.code + ': ' + r.error.message : 'exit ' + r.status}）：\n${tail}`)
  }
  return true
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 安装条目。返回 { ok, message, pkgName, rowId }。
 * @param ctx - 插件上下文（用于解析 profile 目录）。
 * @param input - { id, title?, source }。
 */
async function install(ctx, input) {
  const rowId = safeRowId(input && input.id)
  const source = input && input.source
  if (!source || typeof source !== 'object') throw new Error('缺少 source 分发源')
  const { srcDir, temp } = await resolveSourceDir(source)
  let pkgName = null
  try {
    const pkgDir = path.resolve(srcDir)
    const { pkgName: name } = validatePackage(pkgDir)
    pkgName = name

    const profileDir = resolveProfileDir(ctx)
    const { manifestPath, patchPath, packagesRoot } = profilePaths(profileDir)
    const staged = path.join(packagesRoot, rowId)

    stagePackage(pkgDir, staged)
    try {
      addDependency(manifestPath, pkgName, staged)
    } catch (err) {
      fs.rmSync(staged, { recursive: true, force: true })
      throw err
    }
    runPnpmInstall(profileDir)
    appendPatchRow(patchPath, rowId, pkgName) // 最后写 patch，让 watcher 在链接就绪后重组合
    return {
      ok: true,
      message: `已安装「${pkgName}」到 DSH profile（${path.basename(profileDir)}），刷新页面后生效`,
      pkgName,
      rowId,
      profileDir,
    }
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true })
  }
}

/**
 * 卸载条目：移除 patch 行、依赖与托管目录，然后 pnpm install。
 */
function uninstall(ctx, input) {
  const rowId = safeRowId(input && input.id)
  const profileDir = resolveProfileDir(ctx)
  const { manifestPath, patchPath, packagesRoot } = profilePaths(profileDir)
  const staged = path.join(packagesRoot, rowId)

  let pkgName = null
  if (fs.existsSync(path.join(staged, 'package.json'))) {
    try { pkgName = readJson(path.join(staged, 'package.json')).name } catch { /* 忽略 */ }
  }
  removePatchRow(patchPath, rowId)
  if (pkgName) removeDependency(manifestPath, pkgName)
  fs.rmSync(staged, { recursive: true, force: true })
  try { if (fs.existsSync(packagesRoot) && fs.readdirSync(packagesRoot).length === 0) fs.rmdirSync(packagesRoot) } catch { /* 忽略 */ }
  runPnpmInstall(profileDir)
  return { ok: true, message: `已卸载「${pkgName || rowId}」`, pkgName, rowId }
}

module.exports = { install, uninstall, resolveProfileDir, PATCH_MARKER, PACKAGES_DIR }
