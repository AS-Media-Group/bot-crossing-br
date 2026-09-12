import test from 'node:test'
import assert from 'node:assert/strict'

import { askJarvis, jarvisHealth } from '../src/game/jarvis.js'

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

test('the panel only appears when Jarvis is actually there', async () => {
  assert.equal(await withFetch(async () => ({ ok: true, json: async () => ({ ok: true }) }), jarvisHealth), true)
  assert.equal(await withFetch(async () => { throw new Error('ECONNREFUSED') }, jarvisHealth), false)
})

test('a health check that never answers gives up and reports Jarvis as not there', async () => {
  // A fetch that answers "ok" only after 3 s unless it is aborted first — a stand-in for a port that
  // accepts the connection and then says nothing. The ref'd timer keeps the event loop alive, so the
  // test waits on the abort for real rather than ending early with the promise still pending.
  const hanging = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ ok: true }), 3000)
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(opts.signal.reason)
      })
    })

  const started = Date.now()
  assert.equal(await withFetch(hanging, () => jarvisHealth(50)), false)
  assert.ok(Date.now() - started < 1000, 'it gives up on its own deadline, not the server\'s')
})

test('a question goes to Jarvis and the reply comes back whole', async () => {
  const reply = await withFetch(
    async (url, opts) => {
      assert.match(String(url), /127\.0\.0\.1:5281\/ask/)
      assert.equal(JSON.parse(opts.body).question, 'what needs me')
      return { ok: true, json: async () => ({ text: 'Two threads need you.', detail: 'd', sources: [], lane: 'fast', ms: 40 }) }
    },
    () => askJarvis('what needs me'),
  )
  assert.equal(reply.text, 'Two threads need you.')
})

test('a failure is a sentence, not an exception the page has to catch', async () => {
  const reply = await withFetch(async () => { throw new Error('ECONNREFUSED') }, () => askJarvis('hello'))
  assert.match(reply.text, /can't reach Jarvis/i)
  assert.equal(reply.lane, 'error')
})
