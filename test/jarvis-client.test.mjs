import test from 'node:test'
import assert from 'node:assert/strict'

import {
  askJarvis,
  assistant,
  jarvisHealth,
  jarvisInfo,
  loadAssistant,
  resetAssistantForTests,
  voiceUrl,
} from '../src/game/jarvis.js'

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

/** Sets the cached assistant config directly, via a fake `/api/assistant` response, and resets it after. */
const withAssistant = async (config, fn) => {
  await loadAssistant(async () => ({ ok: true, json: async () => config }))
  try {
    return await fn()
  } finally {
    resetAssistantForTests()
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

test('the colony learns whether Jarvis can listen, not just whether it is there', async () => {
  const info = await withFetch(async () => ({ ok: true, json: async () => ({ ok: true, version: '0.1.0', voice: 'ready' }) }), jarvisInfo)
  assert.deepEqual(info, { ok: true, voice: true })
  const typedOnly = await withFetch(async () => ({ ok: true, json: async () => ({ ok: true, version: '0.1.0' }) }), jarvisInfo)
  assert.deepEqual(typedOnly, { ok: true, voice: false })
})

test('no Jarvis reads as "not there"; a garbled answer reads as "there, but can\'t listen"', async () => {
  assert.deepEqual(await withFetch(async () => { throw new Error('ECONNREFUSED') }, jarvisInfo), { ok: false, voice: false })
  assert.deepEqual(await withFetch(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad') } }), jarvisInfo), { ok: true, voice: false })
})

// ── once an assistant service is configured ────────────────────────────────────────────

test('loadAssistant caches whatever /api/assistant answers, and voiceUrl/assistant read the cache', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'wss://assistant.example:8443/voice' },
    () => {
      assert.deepEqual(assistant(), {
        url: 'https://assistant.example:8443',
        token: 'tok-1',
        voiceUrl: 'wss://assistant.example:8443/voice',
      })
      assert.equal(voiceUrl(), 'wss://assistant.example:8443/voice')
    },
  )
  // Reset put it back to the legacy defaults, for every other test in this file.
  assert.deepEqual(assistant(), { url: null, token: null, voiceUrl: 'ws://127.0.0.1:5281/voice' })
  assert.equal(voiceUrl(), 'ws://127.0.0.1:5281/voice')
})

test('with an assistant configured, jarvisInfo checks its own health, and voice checks the derived legacy address', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'ws://127.0.0.1:5281/voice' },
    async () => {
      const info = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true, version: '1.0' }) }
        if (String(url) === 'http://127.0.0.1:5281/health') return { ok: true, json: async () => ({ voice: 'ready' }) }
        throw new Error(`unexpected fetch: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(info, { ok: true, voice: true })
    },
  )
})

test('a wss:// voice address is checked over https, not http', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'wss://voice.example:9443/voice' },
    async () => {
      const info = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true }) }
        if (String(url) === 'https://voice.example:9443/health') return { ok: true, json: async () => ({ voice: 'ready' }) }
        throw new Error(`unexpected fetch: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(info, { ok: true, voice: true })
    },
  )
})

test('the assistant being down never reaches the voice check', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'ws://127.0.0.1:5281/voice' },
    async () => {
      const info = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: false }
        throw new Error(`should not have checked voice while the assistant itself is down: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(info, { ok: false, voice: false })
    },
  )
})

/** A fake streamed NDJSON response, split into two chunks at `splitAt` bytes — deliberately mid-line. */
function ndjsonResponse(lines, splitAt) {
  const full = lines.join('\n') + '\n'
  const bytes = new TextEncoder().encode(full)
  const chunks = [bytes.slice(0, splitAt), bytes.slice(splitAt)]
  let i = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i < chunks.length) return { done: false, value: chunks[i++] }
          return { done: true, value: undefined }
        },
      }),
    },
  }
}

test('the NDJSON reply is read whole even when a line is split across two chunks', async () => {
  const lines = [
    '{"type":"ack","text":"on it"}',
    '{"type":"delta","text":"Hel"}',
    '{"type":"delta","text":"lo"}',
    '{"type":"reply","reply":{"text":"Hello, friend","detail":"d","sources":[],"action":null,"lane":"fast","ms":42,"model":"m","session_id":"s1"}}',
  ]
  // Cuts partway through the second line — not on a newline boundary.
  const splitAt = lines[0].length + 1 + 10
  const deltas = []

  const reply = await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, () =>
    withFetch(async (url, opts) => {
      assert.equal(String(url), 'https://assistant.example:8443/v1/chat')
      assert.equal(opts.headers.authorization, 'Bearer tok-1')
      assert.equal(opts.headers['content-type'], 'application/json')
      assert.deepEqual(JSON.parse(opts.body), { text: 'what needs me', mode: 'typed', surface: 'bot-crossing', stream: true })
      return ndjsonResponse(lines, splitAt)
    }, () => askJarvis('what needs me', { onDelta: (text) => deltas.push(text) })),
  )

  assert.deepEqual(reply, {
    text: 'Hello, friend',
    detail: 'd',
    sources: [],
    action: null,
    lane: 'fast',
    ms: 42,
    model: 'm',
    session_id: 's1',
  })
  assert.deepEqual(deltas, ['Hel', 'lo'])
})

test('an error line with no reply after it is shown as the answer, in the error lane', async () => {
  const lines = ['{"type":"ack","text":"on it"}', '{"type":"error","text":"the model timed out"}']
  const reply = await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, () =>
    withFetch(async () => ndjsonResponse(lines, 5), () => askJarvis('what needs me')),
  )
  assert.deepEqual(reply, { text: 'the model timed out', detail: '', sources: [], lane: 'error', ms: 0 })
})

test('a non-2xx from the assistant is shown as its error, or a generic one if it sent none', async () => {
  const withStatus = (status, body) =>
    withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, () =>
      withFetch(async () => ({ ok: false, status, json: async () => body }), () => askJarvis('hello')),
    )

  assert.deepEqual(await withStatus(401, { error: 'bad token' }), { text: 'bad token', detail: '', sources: [], lane: 'error', ms: 0 })
  assert.deepEqual(await withStatus(500, {}), { text: 'The assistant answered 500', detail: '', sources: [], lane: 'error', ms: 0 })
})

test('a network failure talking to the assistant is a sentence, not an exception', async () => {
  const reply = await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, () =>
    withFetch(async () => { throw new Error('ECONNREFUSED') }, () => askJarvis('hello')),
  )
  assert.match(reply.text, /can't reach the assistant/i)
  assert.equal(reply.lane, 'error')
})

test('the legacy Jarvis path still works exactly as before when /api/assistant says nothing is configured', async () => {
  await withAssistant({ url: null, token: null, voiceUrl: 'ws://127.0.0.1:5281/voice' }, async () => {
    const info = await withFetch(async (url) => {
      assert.match(String(url), /127\.0\.0\.1:5281\/health/)
      return { ok: true, json: async () => ({ ok: true, voice: 'ready' }) }
    }, jarvisInfo)
    assert.deepEqual(info, { ok: true, voice: true })

    const reply = await withFetch(async (url) => {
      assert.match(String(url), /127\.0\.0\.1:5281\/ask/)
      return { ok: true, json: async () => ({ text: 'still legacy', detail: '', sources: [], lane: 'fast', ms: 1 }) }
    }, () => askJarvis('hello'))
    assert.equal(reply.text, 'still legacy')
  })
})

test('the legacy Jarvis path is also what runs when /api/assistant itself cannot be reached', async () => {
  await loadAssistant(async () => { throw new Error('ECONNREFUSED') })
  try {
    assert.deepEqual(assistant(), { url: null, token: null, voiceUrl: 'ws://127.0.0.1:5281/voice' })
    const info = await withFetch(async (url) => {
      assert.match(String(url), /127\.0\.0\.1:5281\/health/)
      return { ok: true, json: async () => ({ ok: true }) }
    }, jarvisInfo)
    assert.equal(info.ok, true)
  } finally {
    resetAssistantForTests()
  }
})

test('a non-2xx from /api/assistant itself also falls back to the legacy path', async () => {
  await loadAssistant(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  try {
    assert.deepEqual(assistant(), { url: null, token: null, voiceUrl: 'ws://127.0.0.1:5281/voice' })
  } finally {
    resetAssistantForTests()
  }
})
