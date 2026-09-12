/**
 * The colony's link to Jarvis, which is a separate private service on this machine.
 *
 * Bot Crossing stays read-only and knows nothing about Claude: it posts a question to localhost
 * and renders whatever comes back. If Jarvis is not installed the panel never appears, which is
 * why the health check exists.
 */
const JARVIS = 'http://127.0.0.1:5281'

/**
 * Bounded, because something that accepts the connection and never answers would otherwise leave
 * the check pending forever. A timeout reads the same as "not running": no panel.
 */
export async function jarvisHealth(timeoutMs = 2000) {
  try {
    const res = await fetch(`${JARVIS}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
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
