/**
 * The confirmation card's pure logic: state transitions, the countdown wording, and which pending
 * requests are new. No DOM here — see `confirm-cards.js`'s own header for why, and
 * `jarvis-client.test.mjs` for the client calls that feed this. (M-9: this file used to also test
 * `cardMarkup()`, an HTML-string renderer nothing outside this test called — removed along with
 * the function itself; the live rendering path's escaping is proven in
 * `test/confirm-panel.test.mjs` instead, against the fake DOM's own `innerHTML` write log.)
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CARD_STATES,
  countdownText,
  createCard,
  markDone,
  markExpired,
  markSending,
  markUnreachable,
  newRequests,
} from '../src/game/confirm-cards.js'

const REQUEST = {
  request_id: 'c_abc123',
  nonce: 'nonce-should-never-leak',
  action: { tool: 'files.trash', summary: 'Trash the old export?', risk: 'delete' },
  expires_at: 1_700_000_060_000,
}

test('a fresh card carries the request\u2019s fields and starts idle \u2014 but never the nonce (ruling B2)', () => {
  const card = createCard(REQUEST)
  assert.deepEqual(card, {
    requestId: 'c_abc123',
    tool: 'files.trash',
    summary: 'Trash the old export?',
    risk: 'delete',
    expiresAt: 1_700_000_060_000,
    state: CARD_STATES.IDLE,
    text: '',
  })
  assert.ok(!('nonce' in card), 'createCard must never copy the nonce onto the model \u2014 confirm-panel.js keeps it in a closure instead')
})

test('a request with no action still makes a card, just with blank fields', () => {
  const card = createCard({ request_id: 'c_1', nonce: 'n', expires_at: 1 })
  assert.equal(card.tool, '')
  assert.equal(card.summary, '')
  assert.equal(card.risk, '')
})

test('idle -> sending on a click, and a click is ignored once already sending', () => {
  const idle = createCard(REQUEST)
  const sending = markSending(idle)
  assert.equal(sending.state, CARD_STATES.SENDING)

  // A second click (e.g. a double-tap) must not restart anything — sending -> sending, unchanged.
  const stillSending = markSending(sending)
  assert.equal(stillSending, sending)
})

test('sending -> done carries the outcome text', () => {
  const done = markDone(markSending(createCard(REQUEST)), 'Moved "export.zip" to the Trash.')
  assert.equal(done.state, CARD_STATES.DONE)
  assert.equal(done.text, 'Moved "export.zip" to the Trash.')
})

test('markDone only finishes a card actually in flight \u2014 idle or already-done are left alone', () => {
  const idle = createCard(REQUEST)
  assert.equal(markDone(idle, 'Done.'), idle, 'an idle card was never sent, so there is nothing to finish')

  const done = markDone(markSending(createCard(REQUEST)), 'Done.')
  const doneAgain = markDone(done, 'Different text.')
  assert.equal(doneAgain, done, 'a card that has already finished cannot finish a second time with different text')
})

test('sending -> idle when the POST never reached the assistant \u2014 the card stays answerable', () => {
  const sending = markSending(createCard(REQUEST))
  const unreachable = markUnreachable(sending)
  assert.equal(unreachable.state, CARD_STATES.IDLE)
  // Nothing else about the card changed — same nonce-less model, same expiry.
  assert.equal(unreachable.requestId, sending.requestId)
  assert.equal(unreachable.expiresAt, sending.expiresAt)
})

test('markUnreachable only reverts a card actually in flight', () => {
  const idle = createCard(REQUEST)
  assert.equal(markUnreachable(idle), idle)
  const done = markDone(markSending(createCard(REQUEST)), 'Done.')
  assert.equal(markUnreachable(done), done, 'a finished card cannot be un-finished by an unrelated unreachable result')
})

test('idle -> expired when the countdown runs out untouched', () => {
  const expired = markExpired(createCard(REQUEST))
  assert.equal(expired.state, CARD_STATES.EXPIRED)
})

test('a card already answered cannot also expire \u2014 the click that reached the server first wins', () => {
  const sending = markSending(createCard(REQUEST))
  assert.equal(markExpired(sending), sending)
  const done = markDone(sending, 'Done.')
  assert.equal(markExpired(done), done)
})

test('the countdown counts down in whole seconds and never says 0s or a negative number', () => {
  const expiresAt = 10_000
  assert.equal(countdownText(expiresAt, 0), '10s left')
  assert.equal(countdownText(expiresAt, 9_500), '1s left')
  assert.equal(countdownText(expiresAt, 9_999), '1s left')
  assert.equal(countdownText(expiresAt, 10_000), 'Expired')
  assert.equal(countdownText(expiresAt, 10_001), 'Expired')
  assert.equal(countdownText(expiresAt, 50_000), 'Expired')
})

test('a missing or malformed expiry reads as expired rather than throwing', () => {
  assert.equal(countdownText(undefined, 0), 'Expired')
  assert.equal(countdownText(Number.NaN, 0), 'Expired')
})

test('only the requests not already shown come back, in the order the assistant sent them', () => {
  const pending = [
    { request_id: 'c_1', nonce: 'n1', action: { tool: 't', summary: 's', risk: 'delete' }, expires_at: 1 },
    { request_id: 'c_2', nonce: 'n2', action: { tool: 't', summary: 's', risk: 'delete' }, expires_at: 1 },
    { request_id: 'c_3', nonce: 'n3', action: { tool: 't', summary: 's', risk: 'delete' }, expires_at: 1 },
  ]
  const fresh = newRequests(pending, new Set(['c_1', 'c_3']))
  assert.deepEqual(fresh.map((r) => r.request_id), ['c_2'])
})

test('an empty or missing pending list, or no shown set at all, never throws', () => {
  assert.deepEqual(newRequests([], new Set()), [])
  assert.deepEqual(newRequests(undefined, undefined), [])
  assert.deepEqual(newRequests([{ request_id: 'c_1' }], undefined), [{ request_id: 'c_1' }])
  // A malformed entry (no id) is simply skipped, not a crash.
  assert.deepEqual(newRequests([null, {}], new Set()), [])
})

// ── security (contract §14): the nonce is never in anything this file writes out ─────────

test('the nonce never appears on the model, however the card got to it', () => {
  const secretNonce = 'SECRET-NONCE-9f8e7d6c5b4a-do-not-leak'
  const request = { request_id: 'c_secret', nonce: secretNonce, action: { tool: 'files.trash', summary: 'Trash it?', risk: 'delete' }, expires_at: Date.now() + 60_000 }

  let card = createCard(request)
  assert.ok(!('nonce' in card), 'the model never carries it \u2014 confirm-panel.js keeps it in a closure of its own, see ruling B2')

  card = markSending(card)
  assert.ok(!('nonce' in card))

  card = markDone(card, `Answered ${'x'.repeat(3)}.`)
  assert.ok(!('nonce' in card))
  assert.ok(!card.text.includes(secretNonce), 'the outcome text is the server\u2019s reply text, never the nonce')
})

test('nothing in this module ever calls console with the nonce, across a full idle\u2192sending\u2192done run', () => {
  const secretNonce = 'SECRET-NONCE-console-check-1a2b3c'
  const calls = []
  const spy = (...args) => calls.push(args)
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug }
  console.log = spy
  console.warn = spy
  console.error = spy
  console.info = spy
  console.debug = spy
  try {
    const request = { request_id: 'c_spy', nonce: secretNonce, action: { tool: 'files.trash', summary: 'Trash it?', risk: 'delete' }, expires_at: Date.now() + 60_000 }
    let card = createCard(request)
    card = markSending(card)
    card = markDone(card, 'Moved to the Trash.')
    countdownText(card.expiresAt)
    newRequests([request], new Set())
  } finally {
    console.log = real.log
    console.warn = real.warn
    console.error = real.error
    console.info = real.info
    console.debug = real.debug
  }
  const flattened = calls.flat().map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
  assert.ok(
    flattened.every((s) => !String(s).includes(secretNonce)),
    'the nonce must never reach console.*'
  )
  assert.equal(calls.length, 0, 'this module should not be logging anything at all')
})
