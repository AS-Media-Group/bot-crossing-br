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
 * Asks the assistant a question. Accepts an optional `{ onDelta, onConfirm }` — the panel does
 * not stream deltas yet, but a comment here is the seam for when it does: `onDelta(text)` fires
 * for every `delta` line, in order, as they arrive. `onConfirm(line)` fires for every `confirm`
 * line — `{type:'confirm', request_id, summary, risk, expires_at}` — the moment the assistant
 * puts a card up, which is *before* the final reply (whose own `action` may also read `'confirm'`
 * once it lands, since a turn that opened a card answers with nothing else to say yet). That line
 * never carries a `nonce` — only `GET /v1/confirm` does — so `onConfirm` is a signal to go fetch
 * the pending list, not something to build a card from directly.
 */
async function askAssistant(question, { onDelta, onConfirm } = {}) {
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
      else if (line.type === 'confirm') onConfirm?.(line)
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

// ── confirmation cards ──────────────────────────────────────────────────────────────────
//
// A risky action (trash a file, delete it for good) waits behind a card the panel renders, and
// the person answers with a click — never a spoken word, and never by re-asking the assistant.
// Both functions here only ever talk to the *configured assistant*, never the legacy `:5281`
// service: the confirm routes are new to it, and there is nothing to fall back to. Neither
// function ever throws — a card that cannot be fetched or answered is exactly as safe as one that
// was never opened, so the caller always gets a value back to show, not an exception to catch.

const CONFIRM_UNREACHABLE = "I can't reach the assistant \u2014 it does not seem to be running."

/**
 * Shown when the POST to `/v1/confirm` was actually sent and then failed \u2014 it timed out, the
 * network dropped, or the body that came back was not JSON (I2). Unlike `CONFIRM_UNREACHABLE`, the
 * assistant may well have received it: the gateway waits up to 20s to run the action before
 * answering, so saying "can't reach the assistant" here would be wrong at exactly the moment it
 * matters most \u2014 the action may have already happened. The nonce is still not spent client-side,
 * so a retry sends the very same one again; the gateway deletes a request after one answer, so if
 * the first attempt did land, the retry comes back `status: 'unknown'` from the gateway itself.
 */
const CONFIRM_UNKNOWN_OUTCOME = "I didn't hear back, so I can't tell if that went through."

/** A plain sentence for a status the server did not send its own `reply.text` alongside. */
const CONFIRM_STATUS_TEXT = {
  confirmed: 'Done.',
  declined: 'Okay, cancelled.',
  expired: "That one's expired, so I've left it alone.",
  unknown: "I couldn't find that request anymore.",
  refused: "That wasn't allowed.",
}

/**
 * The richer form behind `pendingConfirmations()`. Same fetch, same never-throws contract, but it
 * keeps "the request itself failed" (`ok: false`) apart from "it succeeded, and there is
 * genuinely nothing pending" (`ok: true, requests: []`) — a distinction `pendingConfirmations()`
 * collapses on purpose, because most callers only ever want the list. The confirm-card glue
 * (`confirm-panel.js`) is the one caller that needs to tell them apart: a `confirm` signal from
 * the assistant promised a card, so if this comes back `ok: false` it has something to say about
 * *why* the card is not showing, and if it comes back `ok: true` with nothing in it, it does not.
 */
export async function pendingConfirmationsDetailed({ fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const { url, token } = cached
  if (!url) return { ok: false, requests: [] }
  try {
    const res = await fetchImpl(`${url}/v1/confirm`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, requests: [] }
    const body = await res.json()
    const requests = Array.isArray(body?.requests) ? body.requests : null
    if (requests === null) return { ok: false, requests: [] }
    return { ok: true, requests }
  } catch {
    return { ok: false, requests: [] }
  }
}

/**
 * The assistant's open confirmation cards, or `[]` on any failure at all — nothing configured, a
 * non-200, a body that is not the JSON it expects, or a timeout. `[]` is exactly what an empty
 * pending list looks like, which is the right thing for a panel to show either way: nothing to
 * confirm right now. A thin wrapper over `pendingConfirmationsDetailed`, for callers that only
 * ever want the list.
 */
export async function pendingConfirmations(opts) {
  return (await pendingConfirmationsDetailed(opts)).requests
}

/**
 * Answers one card. `decision` is `'yes'` or `'no'`; `how` is always `'click'` — a card is the
 * only way 3A confirms anything, so this file never sends anything else. The gateway can answer
 * with a non-2xx status (404 unknown, 410 expired, 403 refused) whose *body* still carries the
 * real `status`, so that body is always read, never just the HTTP status code.
 *
 * Returns `{status, text}`: `text` is the server's own `reply.text` when it sent one (the outcome
 * of whatever the card asked to do), otherwise a plain sentence for the status. Two failure shapes
 * both read as `status: 'unreachable'` (this file's own name for it; the gateway never sends it),
 * but with different wording (I2): nothing configured at all \u2014 the POST was never even attempted \u2014
 * gets `CONFIRM_UNREACHABLE`, the same "can't reach it" sentence `askJarvis` uses elsewhere in this
 * file; a POST that was actually sent and then timed out, failed on the network, or came back with
 * a body that was not JSON gets `CONFIRM_UNKNOWN_OUTCOME` instead, since the assistant may already
 * have run the action by the time this gives up. The default deadline (25s) is deliberately longer
 * than the gateway's own 20s wait for the action to run before it answers, so a slow-but-successful
 * "Yes" does not itself manufacture the very failure this distinction exists to word carefully.
 */
export async function answerConfirmation({ request_id, nonce, decision }, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  const { url, token } = cached
  if (!url) return { status: 'unreachable', text: CONFIRM_UNREACHABLE }
  let res
  try {
    res = await fetchImpl(`${url}/v1/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'confirm.answer', request_id, nonce, decision, how: 'click' }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // The POST was already sent \u2014 see CONFIRM_UNKNOWN_OUTCOME's own comment for why this must not
    // say "can't reach the assistant".
    return { status: 'unreachable', text: CONFIRM_UNKNOWN_OUTCOME }
  }
  let body
  try {
    body = await res.json()
  } catch {
    return { status: 'unreachable', text: CONFIRM_UNKNOWN_OUTCOME }
  }
  const status = body?.status || 'unknown'
  const text = body?.reply?.text || CONFIRM_STATUS_TEXT[status] || CONFIRM_UNREACHABLE
  return { status, text }
}
