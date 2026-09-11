import http from 'node:http'
import fsp from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiMiddleware, isLocalHost } from './api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, '..', 'dist')
const PORT = Number(process.env.PORT) || 5274
const HOST = process.env.BOT_CROSSING_HOST || '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** Resolve inside dist/ only — a request can never climb out with `..`. */
function resolveInDist(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(DIST, rel || 'index.html')
  return file === DIST || file.startsWith(DIST + path.sep) ? file : null
}

/**
 * One request, start to finish. Exported for the tests, which want this and not a socket.
 *
 * Nothing may throw past it: a rejection out of an `http` handler is unhandled, and Node's answer to
 * one of those is to end the process — so one malformed URL, or one failed save, took the whole
 * colony down with it.
 */
export async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname.startsWith('/api/')) return await apiMiddleware(req, res, null)

    // The API checks Host itself. The app's own files get the same DNS-rebinding check here.
    if (!isLocalHost(req)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    let file
    try {
      file = resolveInDist(url.pathname)
    } catch {
      res.writeHead(400).end('Bad request') // a `%` escape that decodes to nothing
      return
    }
    if (!file) {
      res.writeHead(403).end('Forbidden')
      return
    }
    try {
      if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      file = path.join(DIST, 'index.html') // SPA fallback
    }

    try {
      const body = await fsp.readFile(file)
      const type = TYPES[path.extname(file)] || 'application/octet-stream'
      const cache = file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache })
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end(String(err?.message || err))
  }
}

/** Run as `node server/serve.mjs` — not when a test imports `handler`. */
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const server = http.createServer(handler)
  server.on('error', (err) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Bot Crossing: port ${PORT} is already in use — is another copy running? Set PORT to run a second.`
        : `Bot Crossing: ${err.message}`
    )
    process.exit(1)
  })
  server.listen(PORT, HOST, () => {
    console.log(`Bot Crossing → http://${HOST}:${PORT}`)
  })
}
