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
