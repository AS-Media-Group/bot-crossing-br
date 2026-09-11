/**
 * Usage, as a person reads it.
 *
 * The server counts tokens per session and leaves it there, because the page already knows which
 * zone every thread belongs to — joining here costs nothing and saves the server scanning the
 * threads again on every poll.
 *
 * No DOM in this file. The wording and the arithmetic are the part worth testing.
 */

/** Tokens with no thread to put them against: archived, hidden, or a worktree that has gone. */
const ELSEWHERE = 'Elsewhere'

const blank = () => ({ output: 0, input: 0, cacheWrite: 0, cacheRead: 0, messages: 0 })

function addInto(into, t) {
  into.output += t.output || 0
  into.input += t.input || 0
  into.cacheWrite += t.cacheWrite || 0
  into.cacheRead += t.cacheRead || 0
  into.messages += t.messages || 0
  return into
}

/**
 * Per-zone totals, busiest first.
 *
 * A thread is matched by the session id the harness gave it (`ref.cliSessionId`) or by the tail of
 * its prefixed id — `claude-code:<uuid>`, `claude-cowork:local_<uuid>` — since that tail is the
 * name of the transcript the tokens were read from.
 */
export function zoneUsage(sessions, threads) {
  const entries = Object.entries(sessions || {})
  if (!entries.length) return []

  const zoneOf = new Map()
  for (const t of threads || []) {
    const project = t?.project
    if (!project) continue
    for (const key of [t.ref?.cliSessionId, String(t.id || '').split(':').pop()]) {
      if (key && !zoneOf.has(key)) zoneOf.set(key, project)
    }
  }

  const byZone = new Map()
  for (const [session, totals] of entries) {
    if (!totals?.messages) continue
    const name = zoneOf.get(session) || ELSEWHERE
    if (!byZone.has(name)) byZone.set(name, { name, ...blank() })
    addInto(byZone.get(name), totals)
  }

  // Unplaced tokens are real, so they are shown — but always last, never competing for the eye
  // with a zone the person recognises.
  return [...byZone.values()].sort((a, b) => {
    if (a.name === ELSEWHERE) return 1
    if (b.name === ELSEWHERE) return -1
    return b.output - a.output
  })
}

/** `12.4k`, `2.36B` — two significant-ish figures, because the magnitude is the message. */
export function formatTokens(n) {
  const v = Number(n) || 0
  const unit = (div, suffix) => {
    const scaled = v / div
    return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(scaled >= 10 ? 1 : 2))}${suffix}`
  }
  if (v >= 1e9) return unit(1e9, 'B')
  if (v >= 1e6) return unit(1e6, 'M')
  if (v >= 1e3) return unit(1e3, 'k')
  return String(Math.round(v))
}

const ago = (ms) => {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/**
 * The floating bar's chip: `5h 23% · 7d 41%`.
 *
 * Returns null when there is nothing to show, which is the honest answer on a plan with no
 * windows, or before a status line has run since the last restart. A zero would read as "none
 * used", and that is the one thing the chip must never say by accident.
 */
export function limitChip(limits) {
  if (!limits) return null
  const parts = []
  if (limits.fiveHour) parts.push(`5h ${Math.round(limits.fiveHour.usedPercentage)}%`)
  if (limits.sevenDay) parts.push(`7d ${Math.round(limits.sevenDay.usedPercentage)}%`)
  if (!parts.length) return null

  const age = ago(limits.ageMs || 0)
  return {
    text: parts.join(' · '),
    stale: Boolean(limits.stale),
    title: limits.stale
      ? `Claude plan limits as of ${age} — status lines only run in a terminal session, so this waits for the next one`
      : `Claude plan limits, ${age}`,
  }
}

/** Unix seconds to "resets in 3h 5m". Past resets are past, never a negative countdown. */
export function resetLabel(resetsAt, now = Date.now()) {
  if (!resetsAt) return ''
  const left = Number(resetsAt) * 1000 - now
  if (left <= 0) return 'reset already'
  const mins = Math.floor(left / 60_000)
  if (mins < 1) return 'resets in under a minute'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  // The weekly window sits days out, where hours stop being a unit anyone reads.
  if (h >= 48) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
  return `resets in ${h ? `${h}h ${m}m` : `${m}m`}`
}
