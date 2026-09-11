/**
 * The built-app server (`npm run serve`), driven in-process. It has to survive whatever a browser —
 * or, with BOT_CROSSING_HOST set, anything else on the network — sends it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inject } from './support/inject.mjs'

process.env.BOT_CROSSING_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-serve-'))
delete process.env.BOT_CROSSING_HOST
const { handler } = await import('../server/serve.mjs')

test('a path whose % escape decodes to nothing is a 400, not a dead server', async () => {
  const res = await inject(handler, { url: '/%E0%A4%A', headers: { host: 'localhost:5274' } })
  assert.equal(res.status, 400)
})

test("the app's files answer only to this machine's own Host, as the API does", async () => {
  const res = await inject(handler, { url: '/index.html', headers: { host: 'evil.example:5274' } })
  assert.equal(res.status, 403)
})
