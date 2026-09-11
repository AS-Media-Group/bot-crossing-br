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
import { setTimeout as delay } from 'node:timers/promises'
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
delete process.env.BOT_CROSSING_COWORK_SESSIONS
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

/** The API read once at import, with BOT_CROSSING_ALLOWED_HOSTS set only for that import. */
async function apiAllowing(names) {
  process.env.BOT_CROSSING_ALLOWED_HOSTS = names
  try {
    return await apiWith(await scratch('data'))
  } finally {
    delete process.env.BOT_CROSSING_ALLOWED_HOSTS
  }
}

test('a name listed in BOT_CROSSING_ALLOWED_HOSTS is answered, as its own origin, for reads and saves', async () => {
  // What Tailscale Serve forwards: the Mac's tailnet name, over https, or its short MagicDNS name.
  const api = await apiAllowing('asmg-mac-9.tail1234.ts.net, ASMG-Mac-9')
  for (const [host, origin] of [
    ['asmg-mac-9.tail1234.ts.net', 'https://asmg-mac-9.tail1234.ts.net'],
    ['asmg-mac-9', 'http://asmg-mac-9'],
  ]) {
    const headers = { host, origin, 'sec-fetch-site': 'same-origin' }
    assert.equal((await call(api, 'GET', '/api/state', { headers })).status, 200, host)
    // Answered rather than refused: a first save lands (200), a later base-less one is sent to merge (409).
    assert.notEqual((await call(api, 'PUT', '/api/state', { headers, body: { archived: [] } })).status, 403, host)
  }
})

test('an allowed name widens nothing else: other hosts, and other origins on it, are still refused', async () => {
  const api = await apiAllowing('asmg-mac-9.tail1234.ts.net')
  assert.equal((await call(api, 'GET', '/api/state', { headers: { host: 'evil.example', origin: undefined } })).status, 403)
  const crossSite = { host: 'asmg-mac-9.tail1234.ts.net', origin: 'https://evil.example' }
  assert.equal((await call(api, 'PUT', '/api/state', { headers: crossSite, body: { archived: [] } })).status, 403)
  // With the variable unset, the tailnet name is just another foreign Host.
  const plain = await apiWith(await scratch('data'))
  const tailnet = { host: 'asmg-mac-9.tail1234.ts.net', origin: 'https://asmg-mac-9.tail1234.ts.net' }
  assert.equal((await call(plain, 'GET', '/api/state', { headers: tailnet })).status, 403)
})

// ── what it will act on ───────────────────────────────────────────────────────

/**
 * Stand-ins for `open` / `xdg-open`, first on PATH, that only write down what they were asked to
 * open. A test that expects nothing to launch can then prove it — and one that fails on the way to
 * that proof opens nothing on the machine running it.
 */
async function fakeOpener() {
  const bin = await scratch('bin')
  const log = path.join(bin, 'opened.log')
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`
  for (const name of ['open', 'xdg-open']) await fsp.writeFile(path.join(bin, name), script, { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  return { opened: async () => (await fsp.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) }
}

test('reveal and new session refuse a folder no thread ever ran in', { skip: process.platform === 'win32' }, async () => {
  const opener = await fakeOpener()
  const api = await apiWith(await scratch('data'))
  const stranger = await scratch('stranger') // exists, is a directory, and no thread ever ran in it
  const bundle = path.join(stranger, 'Calculator.app') // `open` launches one of these
  await fsp.mkdir(bundle)
  for (const url of ['/api/reveal', '/api/new-session']) {
    for (const folder of [stranger, bundle]) {
      const res = await call(api, 'POST', url, { body: { folder, harness: 'claude-code' } })
      assert.equal(res.status, 400, `${url} ${folder}`)
    }
  }
  await delay(200) // the opener is spawned detached; give a mistaken one time to write its log
  assert.deepEqual(await opener.opened(), [], 'nothing was handed to the opener')
})

// ── what it does when the disk misbehaves ─────────────────────────────────────

test('a colony write that fails is an error reply, not a crashed server', async () => {
  const dir = await scratch('notadir')
  const file = path.join(dir, 'notadir')
  await fsp.writeFile(file, 'a regular file where a folder should be')
  // ENOTDIR on the way to the data folder — much how a drive that has gone away fails.
  const api = await apiWith(path.join(file, 'data'))
  const res = await call(api, 'PUT', '/api/state', { body: { archived: ['x'] } })
  assert.ok(res.status >= 500 && res.status < 600, `got ${res.status}`)
})

test('a colony file that is not valid JSON is reported, and never replaced', async () => {
  const dir = await scratch('data')
  const file = path.join(dir, 'colony.json')
  const typo = '{"version":2,"archived":["claude-code:a"],"plots":{"p":[[0,0]]},"updatedAt":1000,}'
  await fsp.writeFile(file, typo)
  const api = await apiWith(dir)
  assert.equal((await call(api, 'GET', '/api/state')).status, 503)
  assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: [] } })).status, 503)
  assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: [], baseUpdatedAt: 1000 } })).status, 503)
  assert.equal(await fsp.readFile(file, 'utf8'), typo, 'the file is exactly as it was')
})

test(
  'an unreadable colony file is reported, and never replaced',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    const dir = await scratch('data')
    const file = path.join(dir, 'colony.json')
    const good = JSON.stringify({ version: 2, archived: ['claude-code:a'], updatedAt: 1000 })
    await fsp.writeFile(file, good)
    await fsp.chmod(file, 0o000)
    try {
      const api = await apiWith(dir)
      assert.equal((await call(api, 'GET', '/api/state')).status, 503)
      assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: [] } })).status, 503)
    } finally {
      await fsp.chmod(file, 0o644)
    }
    assert.equal(await fsp.readFile(file, 'utf8'), good)
  }
)

test('a save against a colony file that has vanished does not start a new one', async () => {
  const dir = await scratch('data')
  const api = await apiWith(dir)
  const res = await call(api, 'PUT', '/api/state', { body: { archived: ['x'], baseUpdatedAt: 12345 } })
  assert.equal(res.status, 503)
  await assert.rejects(fsp.access(path.join(dir, 'colony.json')), 'nothing was written')
})

test('a first save against a real colony it never saw gets the disk state back, to merge', async () => {
  const dir = await scratch('data')
  await fsp.writeFile(path.join(dir, 'colony.json'), JSON.stringify({ version: 2, archived: ['claude-code:a'], updatedAt: 1000 }))
  const api = await apiWith(dir)
  const res = await call(api, 'PUT', '/api/state', { body: { archived: [] } })
  assert.equal(res.status, 409)
  assert.deepEqual(res.json.archived, ['claude-code:a'])
})

test('a data folder whose parent has gone is not quietly re-created', async () => {
  const root = await scratch('gone')
  const api = await apiWith(path.join(root, 'unmounted-drive', 'data'))
  assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: ['x'] } })).status, 503)
  await assert.rejects(fsp.access(path.join(root, 'unmounted-drive')))
})

test('the thread list still answers when the colony file cannot be read', async () => {
  // Passes before this task too; it guards the new throw in readState from reaching /api/threads.
  const dir = await scratch('data')
  await fsp.writeFile(path.join(dir, 'colony.json'), '{ not json')
  const api = await apiWith(dir)
  const res = await call(api, 'GET', '/api/threads')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.threads, [])
})

test('a page will not merge an empty colony over the one it holds', async () => {
  const disk = {
    version: 2, archived: ['claude-code:a'], archivedAt: {}, opened: [], plots: { p: [[0, 0]] },
    seen: {}, hiddenProjects: [], viewedAt: {}, settings: null, updatedAt: 1000,
  }
  const emptied = { ...disk, archived: [], plots: {}, updatedAt: 0 }
  const realFetch = globalThis.fetch
  let puts = 0
  globalThis.fetch = async (_url, opts = {}) => {
    const answer = (status, body) => ({ ok: status < 300, status, statusText: '', json: async () => body })
    if ((opts.method || 'GET') === 'GET') return answer(200, disk)
    puts += 1
    return answer(409, emptied)
  }
  try {
    const { fetchState, saveState } = await import('../src/game/api.js')
    const state = await fetchState()
    await assert.rejects(saveState({ ...state, seen: { t: 1 } }))
    assert.equal(puts, 1, 'no second attempt, built on the empty colony')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ── what Claude has spent ─────────────────────────────────────────────────────

test('usage is readable, and is private to the colony page like everything else', async () => {
  const api = await apiWith(await scratch('data'))

  const mine = await call(api, 'GET', '/api/usage')
  assert.equal(mine.status, 200)
  // The home this file runs against is empty, so there is nothing to count and nothing to hide.
  assert.deepEqual(mine.json.days, [])
  assert.equal(mine.json.limits, null, 'no saved limits means no numbers, never a zero')
  assert.equal(typeof mine.json.stats.files, 'number')

  const theirs = await call(api, 'GET', '/api/usage', { headers: { origin: 'http://localhost:3000' } })
  assert.equal(theirs.status, 403, 'token counts are as private as thread titles')
})

test('usage reports the limits a status line saved beside the colony', async () => {
  const dataDir = await scratch('data')
  await fsp.writeFile(
    path.join(dataDir, 'limits.json'),
    JSON.stringify({
      savedAt: Date.now(),
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } },
    }),
  )
  const api = await apiWith(dataDir)

  const { json } = await call(api, 'GET', '/api/usage')
  assert.equal(json.limits.fiveHour.usedPercentage, 23.5)
  assert.equal(json.limits.sevenDay.usedPercentage, 41.2)
  assert.equal(json.limits.stale, false)
})

test('the bar chip can ask for the limits alone, without a scan of every transcript', async () => {
  const dataDir = await scratch('data')
  await fsp.writeFile(
    path.join(dataDir, 'limits.json'),
    JSON.stringify({ savedAt: Date.now(), rate_limits: { five_hour: { used_percentage: 12, resets_at: 1738425600 } } }),
  )
  const api = await apiWith(dataDir)

  const { status, json } = await call(api, 'GET', '/api/limits')

  assert.equal(status, 200)
  assert.equal(json.limits.fiveHour.usedPercentage, 12)
  // The chip is polled every minute and a token scan costs half a second of filesystem work, so
  // the two are separate answers: this one reads a single small file.
  assert.equal(json.days, undefined)
  assert.equal(json.sessions, undefined)

  assert.equal((await call(api, 'GET', '/api/limits', { headers: { origin: 'http://localhost:3000' } })).status, 403)
})

test('asked for no particular window, usage answers for the week', async () => {
  const api = await apiWith(await scratch('data'))
  assert.equal((await call(api, 'GET', '/api/usage')).json.window, 7)
  assert.equal((await call(api, 'GET', '/api/usage?days=14')).json.window, 14)
})

test('a nonsense days parameter cannot turn a poll into a full-history scan', async () => {
  const api = await apiWith(await scratch('data'))
  // An unreadable ask falls back to the week; a readable one out of range is clamped into it.
  for (const [days, window] of [
    ['0', 1],
    ['-5', 1],
    ['9999', 31],
    ['banana', 7],
    ['', 7],
  ]) {
    const { status, json } = await call(api, 'GET', `/api/usage?days=${days}`)
    assert.equal(status, 200)
    assert.equal(json.window, window, `days=${days}`)
  }
})
