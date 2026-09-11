/**
 * Turning usage numbers into something a person can read at a glance.
 *
 * Pure functions, no DOM: the arithmetic and the wording are what go wrong here, and both are
 * worth pinning down. The join is the interesting one — the server counts tokens per *session*
 * and the page already knows which zone each thread belongs to, so the zone breakdown happens
 * here rather than by making the server scan the threads a second time.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { zoneUsage, formatTokens, limitChip, resetLabel } from '../src/game/usage-view.js'

const thread = (id, project, cliSessionId) => ({ id, project, ref: { cliSessionId } })

test('adds up each zone from the sessions the server counted', () => {
  const sessions = {
    's-1': { output: 100, input: 1, cacheWrite: 10, cacheRead: 1000, messages: 2 },
    's-2': { output: 40, input: 0, cacheWrite: 0, cacheRead: 50, messages: 1 },
    's-3': { output: 7, input: 0, cacheWrite: 0, cacheRead: 0, messages: 1 },
  }
  const threads = [
    thread('claude-code:s-1', 'bot-crossing', 's-1'),
    thread('claude-code:s-2', 'bot-crossing', 's-2'),
    thread('claude-code:s-3', 'esp32manage', 's-3'),
  ]

  const zones = zoneUsage(sessions, threads)

  assert.deepEqual(
    zones.map((z) => [z.name, z.output, z.cacheRead]),
    [
      ['bot-crossing', 140, 1050],
      ['esp32manage', 7, 0],
    ],
    'busiest zone first',
  )
})

test('matches a session however its thread id is prefixed, and keeps the unmatched ones together', () => {
  const sessions = { 'local_abc': { output: 5, messages: 1 }, 'gone-with-the-worktree': { output: 3, messages: 1 } }
  const threads = [{ id: 'claude-cowork:local_abc', project: 'Cowork', ref: {} }]

  const zones = zoneUsage(sessions, threads)

  assert.deepEqual(zones.map((z) => [z.name, z.output]), [
    ['Cowork', 5],
    // Archived threads, deleted worktrees, threads in a hidden repo: real tokens with no zone to
    // put them in. Dropping them would make the zone rows quietly disagree with the day total.
    ['Elsewhere', 3],
  ])
})

test('says nothing rather than zero when there is nothing to add up', () => {
  assert.deepEqual(zoneUsage({}, []), [])
  assert.deepEqual(zoneUsage(undefined, undefined), [])
})

test('writes token counts the way a person would say them', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(940), '940')
  assert.equal(formatTokens(12_400), '12.4k')
  assert.equal(formatTokens(999_000), '999k')
  assert.equal(formatTokens(2_360_000_000), '2.36B')
})

test('the bar chip shows both windows, and marks itself old rather than lying', () => {
  const fresh = limitChip({ fiveHour: { usedPercentage: 23.5 }, sevenDay: { usedPercentage: 41.2 }, stale: false, ageMs: 1000 })
  // 23.5 reads as 24: a limit shown a shade high costs nothing, one shown low is a surprise.
  assert.equal(fresh.text, '5h 24% · 7d 41%')
  assert.equal(fresh.stale, false)

  const old = limitChip({ fiveHour: { usedPercentage: 5 }, sevenDay: null, stale: true, ageMs: 3 * 60 * 60 * 1000 })
  assert.equal(old.text, '5h 5%')
  assert.equal(old.stale, true)
  assert.match(old.title, /3h ago/)

  assert.equal(limitChip(null), null, 'no numbers means no chip at all')
  assert.equal(limitChip({ fiveHour: null, sevenDay: null }), null)
})

test('counts a reset down in plain words, and never counts up past one', () => {
  const now = Date.UTC(2026, 8, 11, 12, 0, 0)
  assert.equal(resetLabel(now / 1000 + 3 * 3600 + 5 * 60, now), 'resets in 3h 5m')
  // The weekly window is days away, and "resets in 95h 54m" is arithmetic homework.
  assert.equal(resetLabel(now / 1000 + 95 * 3600 + 54 * 60, now), 'resets in 3d 23h')
  assert.equal(resetLabel(now / 1000 + 47 * 3600, now), 'resets in 47h 0m')
  assert.equal(resetLabel(now / 1000 + 45, now), 'resets in under a minute')
  assert.equal(resetLabel(now / 1000 - 60, now), 'reset already')
  assert.equal(resetLabel(null, now), '')
})
