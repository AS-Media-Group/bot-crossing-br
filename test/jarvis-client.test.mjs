import test from 'node:test'
import assert from 'node:assert/strict'

import {
  answerConfirmation,
  askJarvis,
  assistant,
  jarvisHealth,
  jarvisInfo,
  loadAssistant,
  pendingConfirmations,
  pendingConfirmationsDetailed,
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

// ── voice health: two ways a configured assistant may report readiness ─────────────────

test('voice readiness accepts the legacy string and the object shape alike', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'wss://voice.example:9443/voice' },
    async () => {
      const legacyString = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true }) }
        if (String(url) === 'https://voice.example:9443/health') return { ok: true, json: async () => ({ voice: 'ready' }) }
        throw new Error(`unexpected fetch: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(legacyString, { ok: true, voice: true })

      const objectShape = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true }) }
        if (String(url) === 'https://voice.example:9443/health') return { ok: true, json: async () => ({ voice: { installed: true, model: 'kokoro' } }) }
        throw new Error(`unexpected fetch: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(objectShape, { ok: true, voice: true })
    },
  )
})

test('voice readiness is false for an object that says installed: false, or any other shape', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'wss://voice.example:9443/voice' },
    async () => {
      const notInstalled = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true }) }
        if (String(url) === 'https://voice.example:9443/health') return { ok: true, json: async () => ({ voice: { installed: false } }) }
        throw new Error(`unexpected fetch: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(notInstalled, { ok: true, voice: false })

      const missing = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true }) }
        if (String(url) === 'https://voice.example:9443/health') return { ok: true, json: async () => ({}) }
        throw new Error(`unexpected fetch: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(missing, { ok: true, voice: false })
    },
  )
})

// ── deriving the voice health URL from the voice WS URL ─────────────────────────────────

test('the voice health check lives at the origin\'s /health, not relative to a prefixed voice path', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'wss://host:8443/v1/voice' },
    async () => {
      const info = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true }) }
        if (String(url) === 'https://host:8443/health') return { ok: true, json: async () => ({ voice: 'ready' }) }
        throw new Error(`unexpected fetch (health must be at the origin, not /v1/health): ${url}`)
      }, jarvisInfo)
      assert.deepEqual(info, { ok: true, voice: true })
    },
  )
})

test('a plain ws:// voice path with no prefix still derives to http://host:port/health', async () => {
  await withAssistant(
    { url: 'https://assistant.example:8443', token: 'tok-1', voiceUrl: 'ws://host:5281/voice' },
    async () => {
      const info = await withFetch(async (url) => {
        if (String(url) === 'https://assistant.example:8443/health') return { ok: true, json: async () => ({ ok: true }) }
        if (String(url) === 'http://host:5281/health') return { ok: true, json: async () => ({ voice: 'ready' }) }
        throw new Error(`unexpected fetch: ${url}`)
      }, jarvisInfo)
      assert.deepEqual(info, { ok: true, voice: true })
    },
  )
})

// ── askAssistant surfaces a confirm card ─────────────────────────────────────────────────

test('a confirm line in the NDJSON stream reaches the caller\u2019s onConfirm, and the reply keeps action:\u2018confirm\u2019', async () => {
  const lines = [
    '{"type":"ack","text":"on it"}',
    '{"type":"confirm","request_id":"c_1","summary":"Trash the old export?","risk":"delete","expires_at":1700000060000}',
    '{"type":"reply","reply":{"text":"Card up: Trash the old export?","detail":"","sources":[],"action":"confirm","lane":"fast","ms":5,"model":null,"session_id":"s1"}}',
  ]
  const confirms = []
  const reply = await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, () =>
    withFetch(async () => ndjsonResponse(lines, 5), () => askJarvis('trash the export', { onConfirm: (line) => confirms.push(line) })),
  )
  assert.deepEqual(confirms, [{ type: 'confirm', request_id: 'c_1', summary: 'Trash the old export?', risk: 'delete', expires_at: 1700000060000 }])
  assert.equal(reply.action, 'confirm')
  assert.equal(reply.text, 'Card up: Trash the old export?')
})

test('askJarvis with no onConfirm still returns the reply fine \u2014 a caller that does not care about cards is not broken by them', async () => {
  const lines = [
    '{"type":"confirm","request_id":"c_1","summary":"Trash it?","risk":"delete","expires_at":1}',
    '{"type":"reply","reply":{"text":"done","detail":"","sources":[],"action":null,"lane":"fast","ms":1,"model":null,"session_id":"s1"}}',
  ]
  const reply = await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, () =>
    withFetch(async () => ndjsonResponse(lines, 3), () => askJarvis('hello')),
  )
  assert.equal(reply.text, 'done')
})

// ── pendingConfirmations ─────────────────────────────────────────────────────────────────

test('with no assistant configured, pendingConfirmations reads as no cards \u2014 without even trying to fetch', async () => {
  await resetAssistantForTests()
  let called = false
  const requests = await pendingConfirmations({ fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ requests: [] }) } } })
  assert.deepEqual(requests, [])
  assert.equal(called, false)
})

test('pendingConfirmations asks GET /v1/confirm with the assistant\u2019s bearer token, and hands back its requests', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const req = { request_id: 'c_1', nonce: 'n1', action: { tool: 'files.trash', summary: 'Trash the old export?', risk: 'delete' }, expires_at: 1700000060000 }
    const requests = await pendingConfirmations({
      fetchImpl: async (url, opts) => {
        assert.equal(String(url), 'https://assistant.example:8443/v1/confirm')
        assert.equal(opts.method, undefined) // GET, no method override
        assert.equal(opts.headers.authorization, 'Bearer tok-1')
        return { ok: true, json: async () => ({ requests: [req] }) }
      },
    })
    assert.deepEqual(requests, [req])
  })
})

test('a non-200, a body with no requests array, a bad JSON body, or a thrown network error all read as no cards', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    assert.deepEqual(await pendingConfirmations({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ requests: [{ request_id: 'x' }] }) }) }), [])
    assert.deepEqual(await pendingConfirmations({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), [])
    assert.deepEqual(await pendingConfirmations({ fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad') } }) }), [])
    assert.deepEqual(await pendingConfirmations({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } }), [])
  })
})

test('pendingConfirmations gives up on its own deadline rather than hanging on a port that never answers', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const hanging = (url, opts = {}) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ ok: true, json: async () => ({ requests: [] }) }), 3000)
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(opts.signal.reason)
        })
      })
    const started = Date.now()
    assert.deepEqual(await pendingConfirmations({ fetchImpl: hanging, timeoutMs: 50 }), [])
    assert.ok(Date.now() - started < 1000, 'it gives up on its own deadline, not the server\'s')
  })
})

// ── pendingConfirmationsDetailed: the richer form confirm-panel.js needs (ruling 7) ─────────

test('pendingConfirmationsDetailed tells a real empty list apart from a failed fetch \u2014 pendingConfirmations still collapses both to []', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const req = { request_id: 'c_1', nonce: 'n1', action: { tool: 'files.trash', summary: 'Trash it?', risk: 'delete' }, expires_at: 1 }

    const genuinelyEmpty = await pendingConfirmationsDetailed({ fetchImpl: async () => ({ ok: true, json: async () => ({ requests: [] }) }) })
    assert.deepEqual(genuinelyEmpty, { ok: true, requests: [] })

    const withOne = await pendingConfirmationsDetailed({ fetchImpl: async () => ({ ok: true, json: async () => ({ requests: [req] }) }) })
    assert.deepEqual(withOne, { ok: true, requests: [req] })

    const httpFailure = await pendingConfirmationsDetailed({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ requests: [req] }) }) })
    assert.deepEqual(httpFailure, { ok: false, requests: [] })

    const malformedBody = await pendingConfirmationsDetailed({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
    assert.deepEqual(malformedBody, { ok: false, requests: [] })

    const badJson = await pendingConfirmationsDetailed({ fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad') } }) })
    assert.deepEqual(badJson, { ok: false, requests: [] })

    const networkFailure = await pendingConfirmationsDetailed({ fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    assert.deepEqual(networkFailure, { ok: false, requests: [] })

    // pendingConfirmations() is a thin wrapper: same [] either way, exactly as it always has been.
    assert.deepEqual(await pendingConfirmations({ fetchImpl: async () => ({ ok: true, json: async () => ({ requests: [] }) }) }), [])
    assert.deepEqual(await pendingConfirmations({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), [])
  })
})

test('with no assistant configured, pendingConfirmationsDetailed reads as a failure too \u2014 without even trying to fetch', async () => {
  await resetAssistantForTests()
  let called = false
  const result = await pendingConfirmationsDetailed({ fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ requests: [] }) } } })
  assert.deepEqual(result, { ok: false, requests: [] })
  assert.equal(called, false)
})

// ── answerConfirmation ────────────────────────────────────────────────────────────────────

test('with no assistant configured, answerConfirmation reports it cannot reach anything \u2014 without trying to fetch', async () => {
  await resetAssistantForTests()
  let called = false
  const result = await answerConfirmation(
    { request_id: 'c_1', nonce: 'n1', decision: 'yes' },
    { fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ status: 'confirmed' }) } } },
  )
  assert.equal(result.status, 'unreachable')
  assert.match(result.text, /can't reach the assistant/i)
  assert.equal(called, false)
})

test('answerConfirmation POSTs a confirm.answer with how:click, and returns the server\u2019s status and reply text', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const result = await answerConfirmation(
      { request_id: 'c_1', nonce: 'n1', decision: 'yes' },
      {
        fetchImpl: async (url, opts) => {
          assert.equal(String(url), 'https://assistant.example:8443/v1/confirm')
          assert.equal(opts.method, 'POST')
          assert.equal(opts.headers.authorization, 'Bearer tok-1')
          assert.equal(opts.headers['content-type'], 'application/json')
          assert.deepEqual(JSON.parse(opts.body), { type: 'confirm.answer', request_id: 'c_1', nonce: 'n1', decision: 'yes', how: 'click' })
          return { ok: true, json: async () => ({ status: 'confirmed', reply: { text: 'Moved "export.zip" to the Trash.', detail: '', sources: [], action: null } }) }
        },
      },
    )
    assert.deepEqual(result, { status: 'confirmed', text: 'Moved "export.zip" to the Trash.' })
  })
})

test('a status with no reply falls back to a plain sentence for that status', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const answer = (status) =>
      answerConfirmation({ request_id: 'c_1', nonce: 'n1', decision: 'no' }, { fetchImpl: async () => ({ ok: true, json: async () => ({ status }) }) })

    assert.deepEqual(await answer('declined'), { status: 'declined', text: 'Okay, cancelled.' })
    assert.equal((await answer('expired')).status, 'expired')
    assert.equal((await answer('unknown')).status, 'unknown')
    assert.equal((await answer('refused')).status, 'refused')
  })
})

test('a 404/410/403 still carries a real status in its body, and that body is what wins, not the HTTP code', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const answer = (httpStatus, bodyStatus) =>
      answerConfirmation(
        { request_id: 'c_1', nonce: 'n1', decision: 'yes' },
        { fetchImpl: async () => ({ ok: false, status: httpStatus, json: async () => ({ status: bodyStatus }) }) },
      )

    assert.equal((await answer(404, 'unknown')).status, 'unknown')
    assert.equal((await answer(410, 'expired')).status, 'expired')
    assert.equal((await answer(403, 'refused')).status, 'refused')
  })
})

test('a network failure or an unparsable body after the POST reads as an unknown outcome, not "can\u2019t reach the assistant" (I2) \u2014 the action may already have run', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    // The POST was actually sent in both cases below \u2014 unlike the "nothing configured" case,
    // where nothing was ever attempted \u2014 so the gateway may already be running the action.
    // Saying "can't reach the assistant" would be wrong here; the wording must say the outcome is
    // unknown instead, even though the status name the panel's retry logic keys on is unchanged.
    const thrown = await answerConfirmation({ request_id: 'c_1', nonce: 'n1', decision: 'yes' }, { fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
    assert.equal(thrown.status, 'unreachable')
    assert.equal(thrown.text, "I didn't hear back, so I can't tell if that went through.")
    assert.doesNotMatch(thrown.text, /can't reach the assistant/i, 'must not claim the assistant was never reached \u2014 the POST was sent')

    const badJson = await answerConfirmation(
      { request_id: 'c_1', nonce: 'n1', decision: 'yes' },
      { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad') } }) },
    )
    assert.equal(badJson.status, 'unreachable')
    assert.equal(badJson.text, "I didn't hear back, so I can't tell if that went through.")
    assert.doesNotMatch(badJson.text, /can't reach the assistant/i)
  })
})

test('with nothing configured at all, answerConfirmation still says it cannot reach anything \u2014 the POST was genuinely never sent (I2, contrast case)', async () => {
  await resetAssistantForTests()
  const result = await answerConfirmation({ request_id: 'c_1', nonce: 'n1', decision: 'yes' }, { fetchImpl: async () => { throw new Error('should never be called') } })
  assert.equal(result.status, 'unreachable')
  assert.match(result.text, /can't reach the assistant/i, 'this one really is "can\u2019t reach it" \u2014 nothing was ever sent')
})

test('answerConfirmation\u2019s own deadline defaults to 25s (I2) \u2014 up from 4s, so it does not undercut the gateway\u2019s 20s wait for the action to actually run', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const realTimeout = AbortSignal.timeout
    let capturedMs = null
    AbortSignal.timeout = (ms) => {
      capturedMs = ms
      return realTimeout(ms)
    }
    try {
      await answerConfirmation(
        { request_id: 'c_1', nonce: 'n1', decision: 'yes' },
        { fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'confirmed', reply: { text: 'Done.' } }) }) },
      )
    } finally {
      AbortSignal.timeout = realTimeout
    }
    assert.equal(capturedMs, 25000)
  })
})

test('the nonce travels in the POST body and nowhere else \u2014 it is never logged by this function', async () => {
  await withAssistant({ url: 'https://assistant.example:8443', token: 'tok-1' }, async () => {
    const secretNonce = 'SECRET-NONCE-client-test-4d5e6f'
    const calls = []
    const spy = (...args) => calls.push(args)
    const real = { log: console.log, warn: console.warn, error: console.error }
    console.log = spy
    console.warn = spy
    console.error = spy
    try {
      await answerConfirmation(
        { request_id: 'c_1', nonce: secretNonce, decision: 'yes' },
        { fetchImpl: async (url, opts) => { assert.match(opts.body, new RegExp(secretNonce)); return { ok: true, json: async () => ({ status: 'confirmed', reply: { text: 'Done.' } }) } } },
      )
    } finally {
      console.log = real.log
      console.warn = real.warn
      console.error = real.error
    }
    assert.equal(calls.length, 0)
  })
})
