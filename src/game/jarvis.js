/**
 * The colony's link to Jarvis, which is a separate service the colony's own server points at.
 *
 * Bot Crossing stays read-only and knows nothing about which model answers: it reads where the
 * assistant is from `/api/assistant` — same origin, so the server's `isLocalRequest` gate decides
 * who gets the token — and renders whatever comes back. Until that answers, or if it says nothing
 * is configured, the panel falls back to the legacy `http://127.0.0.1:5281` service this file has
 * always spoken to, so an install with no assistant configured keeps working exactly as before.
 */
const JARVIS = 'http://127.0.0.1:5281'

/** The audio route: this window's microphone in, the answer's voice out. Local only, like the rest. */
export const JARVIS_VOICE_URL = 'ws://127.0.0.1:5281/voice'

/** What `/api/assistant` last answered, or the legacy defaults before `loadAssistant` has run. */
let cached = { url: null, token: null, voiceUrl: JARVIS_VOICE_URL }

/**
 * Fetches `/api/assistant` — same origin, so the page never has to know its own address — and
 * caches the result. On any failure (network, non-2xx, a body that is not the JSON it expects)
 * the cache falls back to "nothing configured", which is exactly what makes every function below
 * fall back to the legacy Jarvis path. Never throws.
 */
export async function loadAssistant(fetchImpl = fetch) {
  try {
    const res = await fetchImpl('/api/assistant')
    if (!res.ok) throw new Error(`status ${res.status}`)
    const body = await res.json()
    cached = {
      url: body?.url || null,
      token: body?.token || null,
      voiceUrl: body?.voiceUrl || JARVIS_VOICE_URL,
    }
  } catch {
    cached = { url: null, token: null, voiceUrl: JARVIS_VOICE_URL }
  }
  return cached
}

/** The cached answer from the last `loadAssistant`, or the legacy defaults before it has run. */
export function assistant() {
  return cached
}

/** The configured voice service's address — the assistant's, or the legacy one. */
export function voiceUrl() {
  return cached.voiceUrl
}

/** Test-only: forgets whatever `loadAssistant` cached, so each test starts from the legacy path. */
export function resetAssistantForTests() {
  cached = { url: null, token: null, voiceUrl: JARVIS_VOICE_URL }
}

/**
 * `ws://host:port[/any/path]` (or `wss://…`) to that origin's `http(s)://host:port/health`.
 * Health always lives at the origin's `/health` — never relative to the voice path itself, so
 * `wss://host:8443/v1/voice` becomes `https://host:8443/health`, not `.../v1/health`. Falls back
 * to the old string-rewrite for anything `URL` cannot parse, rather than throwing.
 */
function voiceHealthUrl(voice) {
  try {
    const u = new URL(voice)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/health'
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return voice.replace(/^ws/, 'http').replace(/\/voice$/, '/health')
  }
}

/**
 * Is the assistant there, and can it listen? Bounded, like the health check always was —
 * something that accepts the connection and never answers reads as "not there". Never throws.
 */
export async function jarvisInfo(timeoutMs = 2000) {
  const { url } = cached
  if (!url) return legacyInfo(timeoutMs)

  const ok = await pingOk(`${url}/health`, timeoutMs)
  if (!ok) return { ok: false, voice: false }
  const voice = await pingVoiceReady(voiceHealthUrl(cached.voiceUrl), timeoutMs)
  return { ok: true, voice }
}

async function pingOk(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * A configured assistant may report voice readiness either the legacy way — the string
 * `voice: 'ready'` — or as an object, `voice: { installed: true, ... }`. Both count as ready;
 * anything else (missing, `false`, `installed: false`) does not.
 */
async function pingVoiceReady(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return false
    const body = await res.json()
    const voice = body?.voice
    if (voice === 'ready') return true
    if (voice && typeof voice === 'object') return voice.installed === true
    return false
  } catch {
    return false
  }
}

async function legacyInfo(timeoutMs) {
  let res
  try {
    res = await fetch(`${JARVIS}/health`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    return { ok: false, voice: false }
  }
  if (!res.ok) return { ok: false, voice: false }
  try {
    const body = await res.json()
    return { ok: true, voice: body?.voice === 'ready' }
  } catch {
    return { ok: true, voice: false }
  }
}

export async function jarvisHealth(timeoutMs = 2000) {
  return (await jarvisInfo(timeoutMs)).ok
}

const NO_REPLY = { text: "I can't reach the assistant \u2014 it does not seem to be running.", detail: '', sources: [], lane: 'error', ms: 0 }

/**
 * Reads an NDJSON response body one line at a time, buffering partial lines across chunks — a
 * line can arrive split across two reads, and the last chunk of the stream rarely ends on a
 * newline at all. `onLine` gets each parsed object in order; a line that is not valid JSON is
 * skipped rather than aborting the whole reply.
 */
async function readNdjson(res, onLine) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        onLine(JSON.parse(trimmed))
      } catch {
        // A line that is not JSON tells us nothing; the reply that matters is the final one.
      }
    }
  }
  buffer += decoder.decode()
  const trimmed = buffer.trim()
  if (trimmed) {
    try {
      onLine(JSON.parse(trimmed))
    } catch {
      // Same as above — a trailing partial line is not a reply.
    }
  }
}

/**
 * Asks the assistant a question. Accepts an optional `{ onDelta }` — the panel does not stream
 * yet, but a comment here is the seam for when it does: `onDelta(text)` fires for every `delta`
 * line, in order, as they arrive.
 */
async function askAssistant(question, { onDelta } = {}) {
  const { url, token } = cached
  let reply = null
  let errorText = null
  try {
    const res = await fetch(`${url}/v1/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: question, mode: 'typed', surface: 'bot-crossing', stream: true }),
    })
    if (!res.ok) {
      let body = {}
      try {
        body = await res.json()
      } catch {
        // No JSON body to read the error text from — fall through to the generic one below.
      }
      return { text: body.error || `The assistant answered ${res.status}`, detail: '', sources: [], lane: 'error', ms: 0 }
    }
    await readNdjson(res, (line) => {
      if (line.type === 'delta') onDelta?.(line.text)
      else if (line.type === 'error') errorText = line.text
      else if (line.type === 'reply') reply = line.reply
    })
  } catch {
    return NO_REPLY
  }
  if (reply) return reply
  if (errorText) return { text: errorText, detail: '', sources: [], lane: 'error', ms: 0 }
  return NO_REPLY
}

export async function askJarvis(question, opts) {
  if (cached.url) return askAssistant(question, opts)
  try {
    const res = await fetch(`${JARVIS}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    })
    const body = await res.json()
    if (!res.ok) return { text: body.error || `Jarvis answered ${res.status}`, detail: '', sources: [], lane: 'error', ms: 0 }
    return body
  } catch {
    return { text: "I can't reach Jarvis — it does not seem to be running.", detail: '', sources: [], lane: 'error', ms: 0 }
  }
}
