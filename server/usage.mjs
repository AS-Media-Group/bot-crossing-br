/**
 * What Claude has spent, read from the transcripts the colony already knows about.
 *
 * Read-only, like every other scan here: transcripts are Claude's own files and are never
 * written, and the only thing this module adds to the project's reads is a second pass over
 * files it was already listing.
 *
 * Two facts about the transcripts drive the whole design:
 *
 * - **One assistant message is written as several lines**, each carrying the *same* `usage`
 *   record — one per content block. On a real machine 55% of the usage lines are repeats, so
 *   anything that counts lines reports roughly twice the truth. Messages are de-duplicated by
 *   `message.id` + `requestId`.
 * - **Cache reads dwarf everything else.** Billions of cached-read tokens against millions of
 *   output tokens is normal, and they are priced at a tenth of fresh input. A single "tokens"
 *   number would therefore say nothing at all, so the four kinds are kept apart all the way to
 *   the screen.
 *
 * Transcripts are append-only, so after the first pass each file is read from where the last
 * pass stopped. That is what keeps a poll over a couple of thousand files down to milliseconds.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import claudeCode from './harnesses/claude-code.mjs'
import cowork from './harnesses/claude-cowork.mjs'

/**
 * List prices in dollars per million tokens, for an *estimate* only: on a subscription none of
 * this is billed, and the point of the figure is to make the shape of a day's work legible.
 *
 * `cacheWrite` is the 5-minute write (1.25x input) and `cacheRead` a tenth of input, except
 * where Anthropic prices reads flat. An unknown model still counts its tokens and simply adds
 * nothing to the estimate — a new model must never be able to empty the panel.
 */
export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}

/** Model ids in the transcripts carry a date suffix often enough to matter: `…-4-5-20251001`. */
function priceOf(model) {
  if (PRICES[model]) return PRICES[model]
  const undated = String(model || '').replace(/-\d{8}$/, '')
  return PRICES[undated] || null
}

export function estimateCost(byModel) {
  let usd = 0
  for (const [model, t] of Object.entries(byModel || {})) {
    const p = priceOf(model)
    if (!p) continue
    usd +=
      ((t.input || 0) * p.input +
        (t.output || 0) * p.output +
        (t.cacheWrite || 0) * p.cacheWrite +
        (t.cacheRead || 0) * p.cacheRead) /
      1_000_000
  }
  return usd
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Local dates, because "today" means the day Alex is having, not the one in UTC. */
const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA')

const emptyTotals = () => ({ output: 0, input: 0, cacheWrite: 0, cacheRead: 0, messages: 0 })

function add(into, t) {
  into.output += t.output
  into.input += t.input
  into.cacheWrite += t.cacheWrite
  into.cacheRead += t.cacheRead
  into.messages += t.messages
}

// ── finding the transcripts ───────────────────────────────────────────────────

/**
 * Every `.jsonl` under a root, depth-limited.
 *
 * `accept` is a whitelist rather than a blacklist, because of what sits beside Cowork's records:
 * `audit.jsonl`, `.credentials.json` and friends live in the same tree, and a "read all the
 * logs, skip the ones we know about" rule is one new filename away from reading a credential.
 */
async function transcriptsUnder(root, accept, depth = 8) {
  if (!root) return []
  const found = []
  const walk = async (dir, left) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (left > 0 && (entry.name === '.claude' || !entry.name.startsWith('.'))) await walk(p, left - 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && accept(p)) {
        found.push(p)
      }
    }
  }
  await walk(root, depth)
  return found
}

const CLAUDE_PROJECTS = `${path.sep}.claude${path.sep}projects${path.sep}`

/**
 * Which session a transcript belongs to, so the panel can show usage per zone once the API
 * joins these ids to the threads the scan already found.
 *
 * A subagent's transcript lives at `<session>/subagents/agent-N.jsonl`; its tokens belong to the
 * session that dispatched it, not to a thread of its own.
 */
function sessionOf(file) {
  const parts = file.split(path.sep)
  const sub = parts.lastIndexOf('subagents')
  if (sub > 0) return parts[sub - 1]
  const local = parts.findLast?.((p) => p.startsWith('local_')) ?? parts.filter((p) => p.startsWith('local_')).pop()
  if (local) return local
  return path.basename(file, '.jsonl')
}

// ── reading one transcript ────────────────────────────────────────────────────

/** Bytes from `offset` to the end of the file, as a Buffer so no character is cut in half. */
async function readFrom(file, offset, size) {
  const length = size - offset
  if (length <= 0) return Buffer.alloc(0)
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * A file's running tally, kept across scans and extended with whatever the file has grown by.
 *
 * The cache is keyed by path and holds the byte offset it stopped at, the ids it has already
 * counted, and any half-written trailing line — a transcript being appended to *right now* ends
 * mid-record often enough that dropping it would lose a turn per poll.
 */
async function tallyOf(file, cache, stats) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return null
  }

  let entry = cache?.get(file)
  // A file that has shrunk was rewritten, not appended to: the offset means nothing now.
  if (entry && stat.size < entry.offset) entry = undefined
  if (entry && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs) return entry
  if (!entry) {
    entry = { offset: 0, size: 0, mtimeMs: 0, days: new Map(), ids: new Set(), carry: Buffer.alloc(0) }
  }

  const fresh = await readFrom(file, entry.offset, stat.size)
  stats.bytesRead += fresh.length
  const buf = entry.carry.length ? Buffer.concat([entry.carry, fresh]) : fresh
  const lastBreak = buf.lastIndexOf(0x0a)
  entry.carry = lastBreak === -1 ? buf : buf.subarray(lastBreak + 1)
  const text = lastBreak === -1 ? '' : buf.subarray(0, lastBreak).toString('utf8')

  for (const line of text.split('\n')) {
    if (!line || !line.includes('"usage"')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      stats.skipped++
      continue
    }
    const usage = record?.message?.usage
    if (!usage) continue
    // One message, several lines: the first one counts and the rest are the same tokens again.
    const key = `${record.message.id || ''}:${record.requestId || ''}`
    if (entry.ids.has(key)) {
      stats.duplicates++
      continue
    }
    entry.ids.add(key)

    const at = Date.parse(record.timestamp) || stat.mtimeMs
    const model = record.message.model || 'unknown'
    const t = {
      output: usage.output_tokens || 0,
      input: usage.input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      messages: 1,
    }

    const key2 = dayKey(at)
    let day = entry.days.get(key2)
    if (!day) entry.days.set(key2, (day = { total: emptyTotals(), byModel: new Map() }))
    add(day.total, t)
    let m = day.byModel.get(model)
    if (!m) day.byModel.set(model, (m = emptyTotals()))
    add(m, t)
  }

  entry.offset = stat.size
  entry.size = stat.size
  entry.mtimeMs = stat.mtimeMs
  entry.sessionId = entry.sessionId || sessionOf(file)
  cache?.set(file, entry)
  return entry
}

// ── the answer ────────────────────────────────────────────────────────────────

/**
 * Usage for the last `days` local days, by day, model and session.
 *
 * `roots` and `cache` are injected so this can be tested against a fixture tree, and so the
 * server can hold one cache for the life of the process.
 */
export async function readUsage({ roots, days = 7, now = Date.now(), cache } = {}) {
  // All of `roots` or none of it. Filling in a missing key from the real Claude directories
  // would mean a caller asking about one tree quietly getting another one as well.
  const { cliProjects, coworkStore } = roots ?? {
    cliProjects: claudeCode.paths?.CLI_PROJECTS,
    coworkStore: cowork.paths?.STORE,
  }

  const files = [
    ...(await transcriptsUnder(cliProjects, () => true)),
    ...(await transcriptsUnder(coworkStore, (p) => p.includes(CLAUDE_PROJECTS))),
  ]

  const stats = { files: files.length, bytesRead: 0, duplicates: 0, skipped: 0 }
  const wanted = new Set()
  for (let i = 0; i < days; i++) wanted.add(dayKey(now - i * DAY_MS))

  const byDay = new Map()
  const sessions = {}

  for (const file of files) {
    const tally = await tallyOf(file, cache, stats)
    if (!tally) continue

    for (const [date, day] of tally.days) {
      if (!wanted.has(date)) continue
      let into = byDay.get(date)
      if (!into) byDay.set(date, (into = { date, ...emptyTotals(), byModel: {} }))
      add(into, day.total)
      for (const [model, t] of day.byModel) {
        if (!into.byModel[model]) into.byModel[model] = emptyTotals()
        add(into.byModel[model], t)
      }
      // Sessions are summed from the same days, so the zone rows in the panel add up to the
      // totals printed above them. A lifetime-per-session number does not.
      const id = tally.sessionId
      if (!sessions[id]) sessions[id] = emptyTotals()
      add(sessions[id], day.total)
    }
  }

  const list = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1))
  for (const day of list) day.estimatedUsd = estimateCost(day.byModel)

  return { days: list, sessions, stats, scannedAt: now }
}

// ── the limits the status line saved ──────────────────────────────────────────

/** Older than this and the numbers are shown as history rather than as the current state. */
export const LIMITS_STALE_MS = 15 * 60 * 1000

const window_ = (w) =>
  w && typeof w.used_percentage === 'number' ? { usedPercentage: w.used_percentage, resetsAt: w.resets_at ?? null } : null

/**
 * The 5-hour and weekly plan limits, as last seen by a Claude Code status line.
 *
 * Claude Code hands `rate_limits` to whatever status-line command is configured; a wrapper saves
 * that here. Nothing in this project reads a credential or calls an API to find it out, and a
 * file that is missing, unreadable or nonsense means "no numbers" rather than zeroes — a zero
 * would read as "nothing used", which is the one wrong thing to show.
 */
export async function readLimits(file, now = Date.now()) {
  if (!file) return null
  let raw
  let mtimeMs = 0
  try {
    raw = await fsp.readFile(file, 'utf8')
    mtimeMs = (await fsp.stat(file)).mtimeMs
  } catch {
    return null
  }
  let saved
  try {
    saved = JSON.parse(raw)
  } catch {
    return null
  }
  const limits = saved?.rate_limits
  if (!limits || typeof limits !== 'object') return null

  const savedAt = Number(saved.savedAt) || mtimeMs
  const ageMs = Math.max(0, now - savedAt)
  return {
    fiveHour: window_(limits.five_hour),
    sevenDay: window_(limits.seven_day),
    spendLimit: window_(limits.spend_limit),
    savedAt,
    ageMs,
    stale: ageMs > LIMITS_STALE_MS,
  }
}
