/**
 * serve.mjs — 零依赖静态文件服务器（预览 Harness 创意工坊插件用）。
 * 用法：node scripts/serve.mjs [端口]   默认端口 8357
 * 访问：http://127.0.0.1:8357/
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.argv[2] || process.env.PORT || 8357)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (path === '/') path = '/index.html'
    const file = normalize(join(ROOT, path))
    if (!file.startsWith(normalize(ROOT))) throw new Error('forbidden')
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
  }
}).listen(PORT, () => console.log(`Harness 创意工坊预览服务: http://127.0.0.1:${PORT}/`))
