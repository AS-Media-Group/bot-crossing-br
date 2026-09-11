/**
 * What the colony is allowed to say about Claude usage.
 *
 * Two things this has to get right, because the transcripts make both easy to get wrong:
 * one assistant message is written as several lines carrying the SAME usage record (counting
 * the lines double-counts the tokens), and cache reads dwarf every other number, so they are
 * never folded into one total.
 *
 * Fixture-driven. Nothing here reads the real Claude directories, so it says the same thing on
 * any machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { readUsage, readLimits, estimateCost, PRICES } from '../server/usage.mjs'

// ── fixtures ──────────────────────────────────────────────────────────────────

async function tmpdir() {
  const dir = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'bc-usage-')))
  return dir
}

/** One assistant turn, written the way Claude Code writes it: same usage on every block line. */
function turn({ id, requestId, model, at, output = 0, input = 0, cacheWrite = 0, cacheRead = 0, lines = 1 }) {
  const record = {
    type: 'assistant',
    requestId,
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      role: 'assistant',
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
      },
    },
  }
  return Array.from({ length: lines }, () => JSON.stringify(record)).join('\n') + '\n'
}

const day = (at) => new Date(at).toLocaleDateString('en-CA')

/** Midday UTC, so the local date is the same wherever this runs. */
const NOON = Date.UTC(2026, 8, 11, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

async function writeTranscript(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text)
}

// ── counting ──────────────────────────────────────────────────────────────────

test('counts a turn once, however many lines carry its usage record', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  await writeTranscript(
    path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl'),
    turn({ id: 'msg_1', requestId: 'req_1', model: 'claude-opus-5', at: NOON, output: 300, input: 2, cacheWrite: 1000, cacheRead: 5000, lines: 4 }),
  )

  const usage = await readUsage({ roots: { cliProjects }, now: NOON })

  const today = usage.days.find((d) => d.date === day(NOON))
  assert.deepEqual(
    { output: today.output, input: today.input, cacheWrite: today.cacheWrite, cacheRead: today.cacheRead },
    { output: 300, input: 2, cacheWrite: 1000, cacheRead: 5000 },
    'four lines of one message must count as one message',
  )
  assert.equal(today.byModel['claude-opus-5'].output, 300)
  assert.equal(usage.stats.duplicates, 3)
})

test('keeps days, models and sessions apart', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  await writeTranscript(
    path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl'),
    turn({ id: 'm1', requestId: 'r1', model: 'claude-opus-5', at: NOON, output: 100 }) +
      turn({ id: 'm2', requestId: 'r2', model: 'claude-haiku-4-5', at: NOON, output: 40 }),
  )
  await writeTranscript(
    path.join(cliProjects, '-Users-someone-other', 'session-b.jsonl'),
    turn({ id: 'm3', requestId: 'r3', model: 'claude-opus-5', at: NOON - DAY, output: 7 }) +
      // Older than the window. A session total that counted this would not add up to the days
      // above it, and the panel shows the two side by side.
      turn({ id: 'm4', requestId: 'r4', model: 'claude-opus-5', at: NOON - 30 * DAY, output: 5000 }),
  )

  const usage = await readUsage({ roots: { cliProjects }, now: NOON })

  const today = usage.days.find((d) => d.date === day(NOON))
  const yesterday = usage.days.find((d) => d.date === day(NOON - DAY))
  assert.equal(today.output, 140)
  assert.equal(today.byModel['claude-haiku-4-5'].output, 40)
  assert.equal(yesterday.output, 7)
  assert.equal(usage.sessions['session-a'].output, 140)
  assert.equal(usage.sessions['session-b'].output, 7, 'sessions cover the same window as the days')
  assert.equal(
    Object.values(usage.sessions).reduce((n, s) => n + s.output, 0),
    usage.days.reduce((n, d) => n + d.output, 0),
    'the zone rows in the panel have to add up to the days above them',
  )
})

test('counts subagent transcripts and Cowork transcripts, and never opens Cowork audit files', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  const coworkStore = path.join(root, 'local-agent-mode-sessions')

  await writeTranscript(
    path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl'),
    turn({ id: 'm1', requestId: 'r1', model: 'claude-opus-5', at: NOON, output: 10 }),
  )
  await writeTranscript(
    path.join(cliProjects, '-Users-someone-repo', 'session-a', 'subagents', 'agent-1.jsonl'),
    turn({ id: 'm2', requestId: 'r2', model: 'claude-sonnet-5', at: NOON, output: 5 }),
  )
  await writeTranscript(
    path.join(coworkStore, 'acct', 'org', 'local_x', '.claude', 'projects', '-repo', 'cli-1.jsonl'),
    turn({ id: 'm3', requestId: 'r3', model: 'claude-sonnet-5', at: NOON, output: 3 }),
  )
  // Sits beside Cowork's records. Reading it is the bug this asserts against.
  await writeTranscript(
    path.join(coworkStore, 'acct', 'org', 'local_x', 'audit.jsonl'),
    turn({ id: 'm4', requestId: 'r4', model: 'claude-sonnet-5', at: NOON, output: 999 }),
  )

  const usage = await readUsage({ roots: { cliProjects, coworkStore }, now: NOON })

  const today = usage.days.find((d) => d.date === day(NOON))
  assert.equal(today.output, 18, 'transcript + subagent + Cowork, and nothing from audit.jsonl')
  assert.equal(today.byModel['claude-sonnet-5'].output, 8)
})

test('survives lines that are not JSON, records without usage, and an empty tree', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  await writeTranscript(
    path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl'),
    'not json at all\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) +
      '\n' +
      turn({ id: 'm1', requestId: 'r1', model: 'claude-opus-5', at: NOON, output: 12 }),
  )

  const usage = await readUsage({ roots: { cliProjects }, now: NOON })
  assert.equal(usage.days.find((d) => d.date === day(NOON)).output, 12)

  const nothing = await readUsage({ roots: { cliProjects: path.join(root, 'missing') }, now: NOON })
  assert.equal(nothing.days.length, 0)
  assert.equal(nothing.stats.files, 0)
})

test('only reads the bytes a transcript has grown by', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  const file = path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl')
  const first = turn({ id: 'm1', requestId: 'r1', model: 'claude-opus-5', at: NOON, output: 100 })
  await writeTranscript(file, first)

  const cache = new Map()
  const one = await readUsage({ roots: { cliProjects }, now: NOON, cache })
  assert.equal(one.stats.bytesRead, first.length)

  const second = turn({ id: 'm2', requestId: 'r2', model: 'claude-opus-5', at: NOON, output: 5 })
  await fsp.appendFile(file, second)
  const two = await readUsage({ roots: { cliProjects }, now: NOON, cache })

  assert.equal(two.stats.bytesRead, second.length, 'the second pass must not re-read the first turn')
  assert.equal(two.days.find((d) => d.date === day(NOON)).output, 105)
})

test('re-reads a transcript from the start when it has shrunk', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  const file = path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl')
  await writeTranscript(file, turn({ id: 'm1', requestId: 'r1', model: 'claude-opus-5', at: NOON, output: 100, lines: 3 }))

  const cache = new Map()
  await readUsage({ roots: { cliProjects }, now: NOON, cache })

  const rewritten = turn({ id: 'm9', requestId: 'r9', model: 'claude-opus-5', at: NOON, output: 1 })
  await fsp.writeFile(file, rewritten)
  const after = await readUsage({ roots: { cliProjects }, now: NOON, cache })

  assert.equal(after.days.find((d) => d.date === day(NOON)).output, 1)
  assert.equal(after.stats.bytesRead, rewritten.length)
})

test('holds a half-written last line until the rest of it arrives', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  const file = path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl')
  const whole = turn({ id: 'm1', requestId: 'r1', model: 'claude-opus-5', at: NOON, output: 50 })
  const split = Math.floor(whole.length / 2)
  await writeTranscript(file, whole.slice(0, split))

  const cache = new Map()
  const half = await readUsage({ roots: { cliProjects }, now: NOON, cache })
  assert.equal(half.days.length, 0, 'half a record is not a turn')

  await fsp.appendFile(file, whole.slice(split))
  const done = await readUsage({ roots: { cliProjects }, now: NOON, cache })
  assert.equal(done.days.find((d) => d.date === day(NOON)).output, 50)
})

test('keeps only the asked-for window of days', async () => {
  const root = await tmpdir()
  const cliProjects = path.join(root, 'projects')
  await writeTranscript(
    path.join(cliProjects, '-Users-someone-repo', 'session-a.jsonl'),
    turn({ id: 'm1', requestId: 'r1', model: 'claude-opus-5', at: NOON, output: 1 }) +
      turn({ id: 'm2', requestId: 'r2', model: 'claude-opus-5', at: NOON - 30 * DAY, output: 900 }),
  )

  const usage = await readUsage({ roots: { cliProjects }, now: NOON, days: 7 })

  assert.equal(usage.days.length, 1)
  assert.equal(usage.days[0].date, day(NOON))
})

// ── the limits file ───────────────────────────────────────────────────────────

test('reads the rate limits the status line saved, and says how old they are', async () => {
  const root = await tmpdir()
  const file = path.join(root, 'limits.json')
  const savedAt = NOON - 60_000
  await fsp.writeFile(
    file,
    JSON.stringify({
      savedAt,
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    }),
  )

  const limits = await readLimits(file, NOON)

  assert.equal(limits.fiveHour.usedPercentage, 23.5)
  assert.equal(limits.fiveHour.resetsAt, 1738425600)
  assert.equal(limits.sevenDay.usedPercentage, 41.2)
  assert.equal(limits.ageMs, 60_000)
  assert.equal(limits.stale, false)
})

test('calls limits stale once they are older than the window, and reports nothing at all rather than guessing', async () => {
  const root = await tmpdir()
  const file = path.join(root, 'limits.json')
  await fsp.writeFile(file, JSON.stringify({ savedAt: NOON - 60 * 60_000, rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } }))

  const old = await readLimits(file, NOON)
  assert.equal(old.stale, true)
  assert.equal(old.sevenDay, null, 'a window the status line did not send is absent, not zero')

  await fsp.writeFile(file, '{ this is not json')
  assert.equal(await readLimits(file, NOON), null)
  assert.equal(await readLimits(path.join(root, 'nope.json'), NOON), null)
})

// ── the cost estimate ─────────────────────────────────────────────────────────

test('prices each kind of token from the model it was spent on', async () => {
  const p = PRICES['claude-opus-5']
  const cost = estimateCost({
    'claude-opus-5': { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 },
  })

  assert.equal(cost, p.input + p.output + p.cacheWrite + p.cacheRead)
  assert.ok(p.cacheRead < p.input, 'cache reads are the cheap ones — that is the whole point of showing them apart')
})

test('an unknown model costs nothing rather than breaking the panel', () => {
  assert.equal(estimateCost({ 'claude-from-the-future': { output: 10_000_000 } }), 0)
})
