/**
 * The API's edges — who may call it, what it will act on, and what it does when the disk
 * misbehaves — driven in-process through `support/inject.mjs`, so no port is ever bound.
 *
 * The harness scan is pointed at an empty home before the API is first imported, so nothing in this
 * file reads the machine it runs on. Each test gets its own data folder through a fresh,
 * cache-busted import, because the API reads BOT_CROSSING_DATA once, at import.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inject } from './support/inject.mjs'

const scratch = (label) => fsp.mkdtemp(path.join(os.tmpdir(), `bot-crossing-${label}-`))

const EMPTY_HOME = await scratch('home')
process.env.HOME = EMPTY_HOME
process.env.USERPROFILE = EMPTY_HOME
process.env.APPDATA = path.join(EMPTY_HOME, 'AppData', 'Roaming')
process.env.LOCALAPPDATA = path.join(EMPTY_HOME, 'AppData', 'Local')
process.env.XDG_CONFIG_HOME = path.join(EMPTY_HOME, '.config')
delete process.env.CODEX_HOME
delete process.env.BOT_CROSSING_CURSOR_PROJECTS
delete process.env.BOT_CROSSING_HOST

async function apiWith(dataDir) {
  process.env.BOT_CROSSING_DATA = dataDir
  const { apiMiddleware } = await import(`../server/api.mjs?${dataDir}`)
  return apiMiddleware
}

const HOST = 'localhost:5274'

/** A request as the colony's own page sends it; any header can be overridden, or removed with undefined. */
const call = (api, method, url, { headers = {}, body } = {}) =>
  inject(api, {
    method,
    url,
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', ...headers },
    body,
  })

// ── who may call it ───────────────────────────────────────────────────────────

test('another page on this machine, on another port, can neither read nor write the colony', async () => {
  const api = await apiWith(await scratch('data'))
  assert.equal((await call(api, 'GET', '/api/state', { headers: { origin: 'http://localhost:3000' } })).status, 403)
  const put = await call(api, 'PUT', '/api/state', {
    headers: { origin: 'http://127.0.0.1:8080' },
    body: { archived: ['x'] },
  })
  assert.equal(put.status, 403)
})

test('a request the browser marks as same-site is refused, even with no Origin on it', async () => {
  const api = await apiWith(await scratch('data'))
  const res = await call(api, 'GET', '/api/state', { headers: { origin: undefined, 'sec-fetch-site': 'same-site' } })
  assert.equal(res.status, 403)
})

test("the page's own origin still gets through, however loopback is spelt", async () => {
  const api = await apiWith(await scratch('data'))
  for (const host of ['localhost:5274', '127.0.0.1:5274', '[::1]:5274']) {
    const res = await call(api, 'GET', '/api/state', {
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(res.status, 200, host)
  }
})

test("this machine's LAN address is not trusted unless the colony was served to the network", async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)
  if (!lan) return t.skip('no LAN address on this machine')
  const api = await apiWith(await scratch('data'))
  const host = `${lan.address}:5274`
  assert.equal((await call(api, 'GET', '/api/state', { headers: { host, origin: `http://${host}` } })).status, 403)
})
