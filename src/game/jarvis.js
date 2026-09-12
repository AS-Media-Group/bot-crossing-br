/**
 * The colony's link to Jarvis, which is a separate private service on this machine.
 *
 * Bot Crossing stays read-only and knows nothing about Claude: it posts a question to localhost
 * and renders whatever comes back. If Jarvis is not installed the panel never appears, which is
 * why the health check exists.
 */
const JARVIS = 'http://127.0.0.1:5281'

/** The audio route: this window's microphone in, the answer's voice out. Local only, like the rest. */
export const JARVIS_VOICE_URL = 'ws://127.0.0.1:5281/voice'

/**
 * Is Jarvis there, and can it listen? Bounded, like the health check always was — something that
 * accepts the connection and never answers reads as "not there". Never throws.
 */
export async function jarvisInfo(timeoutMs = 2000) {
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

export async function askJarvis(question) {
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
