/**
 * The dev server's own surface, beyond /api: what Vite itself will serve, and which of its own
 * routes answer. Driven in-process through Vite's middleware stack — no port is bound, and the
 * config is loaded natively, so nothing is written next to it.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { inject } from './support/inject.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-vite-'))
// The config pulls the API in: point its state at scratch space and its scan at an empty home first.
process.env.BOT_CROSSING_DATA = scratch
process.env.HOME = scratch
process.env.USERPROFILE = scratch
// If the editor route were ever reachable, this is what it would launch: nothing at all.
process.env.LAUNCH_EDITOR = '/usr/bin/true'

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  configLoader: 'native',
  cacheDir: path.join(scratch, '.vite'),
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
})
after(() => server.close())

const HOST = 'localhost:5274'
const get = (url, headers = {}) => inject(server.middlewares, { url, headers: { host: HOST, ...headers } })
/** `/@fs/…` for a file inside the repo, each segment escaped — the repo path may hold spaces. */
const fsUrl = (...parts) => '/@fs' + path.join(root, ...parts).split(path.sep).map(encodeURIComponent).join('/')

test('the dev server will not hand out the colony file or anything under .claude', { skip: process.platform === 'win32' }, async () => {
  assert.equal((await get('/.claude/launch.json')).status, 403)
  assert.equal((await get(fsUrl('.claude', 'launch.json'))).status, 403)
  assert.equal((await get(fsUrl('data', 'colony.json'))).status, 403)
})

test('the app itself is still served', async () => {
  assert.equal((await get('/index.html')).status, 200)
})

test("Vite's open-in-editor route is closed", { skip: process.platform === 'win32' }, async () => {
  assert.equal((await get('/__open-in-editor?file=package.json')).status, 404)
})

test('no reply grants CORS to another local origin', async () => {
  const read = await get('/api/state', { origin: 'http://localhost:3000' })
  assert.equal(read.headers['access-control-allow-origin'], undefined)
  const preflight = await inject(server.middlewares, {
    method: 'OPTIONS',
    url: '/api/state',
    headers: { host: HOST, origin: 'http://localhost:3000', 'access-control-request-method': 'PUT' },
  })
  assert.equal(preflight.headers['access-control-allow-origin'], undefined)
})
