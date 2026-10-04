/**
 * The confirmation card's DOM glue (`confirm-panel.js`), driven with the small fake `document`
 * from `test/support/fake-dom.mjs` — see that file's header for why no real DOM library is used.
 *
 * Covers the fix-wave rulings for FX-D:
 *  - B2 (CRITICAL): the nonce is never reachable by walking the panel, `hud`, or `window`.
 *  - 6: an in-flight guard on `refreshConfirmations()`, and `_addConfirmCard`'s own id guard, so
 *    two overlapping refreshes for the same card never produce two cards or two intervals.
 *  - 7: the "can't reach the assistant" placeholder, and the "unreachable" retry path that keeps
 *    a card answerable without spending its nonce.
 *  - 8: accessibility — role/aria-label/aria-describedby/aria-live, the visible countdown not
 *    being a live region, escaping of untrusted fields, and default focus on the first card's No.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ConfirmPanel, FINISHED_VISIBLE_MS } from '../src/ui/confirm-panel.js'
import { CARD_STATES } from '../src/game/confirm-cards.js'
import { createFakeDocument } from './support/fake-dom.mjs'

const request = (overrides = {}) => ({
  request_id: 'c_1',
  nonce: 'nonce-should-never-leak',
  action: { tool: 'files.trash', summary: 'Trash the old export?', risk: 'delete' },
  expires_at: Date.now() + 60_000,
  ...overrides,
})

const newPanel = (overrides = {}) => {
  const document = createFakeDocument()
  const container = document.createElement('div')
  const panel = new ConfirmPanel({
    document,
    container,
    pendingConfirmations: async () => ({ ok: true, requests: [] }),
    answerConfirmation: async () => ({ status: 'confirmed', text: 'Done.' }),
    ...overrides,
  })
  return { document, container, panel }
}

/** Every own property reachable from `root`, walked recursively (cycle-safe; Maps/Sets/arrays too). */
function assertNeverContains(root, needle, seen = new Set()) {
  if (root === null || root === undefined) return
  if (typeof root === 'string') {
    assert.ok(!root.includes(needle), `found the secret in a string: ${JSON.stringify(root).slice(0, 120)}`)
    return
  }
  if (typeof root !== 'object' && typeof root !== 'function') return
  if (seen.has(root)) return
  seen.add(root)
  if (root instanceof Map) {
    for (const [k, v] of root) {
      assertNeverContains(k, needle, seen)
      assertNeverContains(v, needle, seen)
    }
    return
  }
  if (root instanceof Set) {
    for (const v of root) assertNeverContains(v, needle, seen)
    return
  }
  if (Array.isArray(root)) {
    for (const v of root) assertNeverContains(v, needle, seen)
    return
  }
  for (const key of Object.keys(root)) assertNeverContains(root[key], needle, seen)
}

// ── B2 (CRITICAL): the nonce is never reachable, and the click still POSTs the right one ────

test('B2: a recursive walk of the panel (and of anything hud would put on window) never finds the nonce', async () => {
  const secretNonce = 'SECRET-NONCE-panel-walk-9f8e7d6c'
  const posted = []
  const { document, container, panel } = newPanel({
    answerConfirmation: async (body) => {
      posted.push(body)
      return { status: 'confirmed', text: 'Moved "export.zip" to the Trash.' }
    },
  })
  panel._addConfirmCard(request({ nonce: secretNonce }))

  // Stand-in for what main.js does: `window.botCrossing = { ..., hud, ... }`. hud.js itself is
  // too entangled with the real browser (navigator, matchMedia, three.js canvases) to instantiate
  // here — see confirm-panel.js's header — so this walks the actual object graph hud.js would
  // expose through `hud.confirmPanel`, nested a couple of levels the way `window.botCrossing`
  // nests `hud`.
  const fakeHud = { confirmPanel: panel, other: { nested: [panel.cards, panel] } }
  const fakeWindowBotCrossing = { hud: fakeHud, engine: {}, colony: {}, get threads() { return [] } }

  const consoleCalls = []
  const spy = (...args) => consoleCalls.push(args)
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug }
  console.log = console.warn = console.error = console.info = console.debug = spy
  try {
    assertNeverContains(fakeWindowBotCrossing, secretNonce)
    assertNeverContains(document, secretNonce)
    assertNeverContains(container, secretNonce)
  } finally {
    console.log = real.log
    console.warn = real.warn
    console.error = real.error
    console.info = real.info
    console.debug = real.debug
  }
  assert.equal(consoleCalls.length, 0, 'the walk itself must not have logged anything')

  // The nonce still has to work: clicking Yes must POST exactly the nonce the card was created with.
  const entry = panel.cards.get('c_1')
  entry.yesBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posted.length, 1)
  assert.deepEqual(posted[0], { request_id: 'c_1', nonce: secretNonce, decision: 'yes' })
})

test('B2: the model createCard() returns never carries the nonce, and neither does the stored entry', () => {
  const secretNonce = 'SECRET-NONCE-entry-check-1a2b3c'
  const { panel } = newPanel()
  panel._addConfirmCard(request({ nonce: secretNonce }))
  const entry = panel.cards.get('c_1')
  assert.ok(!('nonce' in entry.card))
  assert.ok(!('nonce' in entry))
})

test('M-1: once a real answer comes back the nonce is spent \u2014 no later click can resend it, even if the card\u2019s state is forced back to idle', async () => {
  const secretNonce = 'SECRET-NONCE-m1-nulling-7g8h9i'
  const posted = []
  const { panel } = newPanel({
    answerConfirmation: async (body) => {
      posted.push(body)
      return { status: 'confirmed', text: 'Moved "export.zip" to the Trash.' }
    },
  })
  panel._addConfirmCard(request({ nonce: secretNonce }))
  const entry = panel.cards.get('c_1')

  entry.yesBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posted.length, 1, 'the one real answer')
  assert.equal(posted[0].nonce, secretNonce)
  assert.equal(entry.card.state, 'done')

  // Worst case: the card's model gets reset back to idle by something else entirely (a stray
  // reference, a bug elsewhere) — the state guard alone must not be the only thing stopping
  // a resend. Force it back and re-dispatch on both retained buttons.
  entry.card = { ...entry.card, state: CARD_STATES.IDLE }
  entry.yesBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))

  entry.card = { ...entry.card, state: CARD_STATES.IDLE }
  entry.noBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(
    posted.slice(1).every((p) => p.nonce !== secretNonce),
    'no later POST may carry the spent nonce, however the card\u2019s state got reset'
  )
})

// ── item 6: in-flight guard + id guard, no orphaned interval ────────────────────────────────

test('6: overlapping refreshConfirmations() calls collapse into the fetch already in flight', async () => {
  let fetchCalls = 0
  let resolveFetch
  const { panel } = newPanel({
    pendingConfirmations: () =>
      new Promise((resolve) => {
        fetchCalls += 1
        resolveFetch = resolve
      }),
  })

  const p1 = panel.refreshConfirmations()
  const p2 = panel.refreshConfirmations() // must reuse p1's fetch, not start a second one
  assert.equal(fetchCalls, 1, 'a second overlapping call must not start a second fetch')
  resolveFetch({ ok: true, requests: [request()] })
  await Promise.all([p1, p2])

  assert.equal(panel.cards.size, 1, 'exactly one card')
})

test('6: _addConfirmCard refuses to add an id already on screen, even called directly twice (the second line of defence)', () => {
  const created = []
  const { panel } = newPanel()
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (...args) => {
    created.push(1)
    return realSetInterval(...args)
  }
  let firstEntry
  try {
    panel._addConfirmCard(request())
    firstEntry = panel.cards.get('c_1')
    panel._addConfirmCard(request()) // the same id, as if two resolved fetches both saw it
    assert.equal(panel.cards.size, 1, 'exactly one card')
    assert.equal(panel.cards.get('c_1'), firstEntry, 'the original entry (and its timer) is untouched')
    assert.equal(created.length, 1, 'exactly one interval was ever started')
  } finally {
    globalThis.setInterval = realSetInterval
    if (firstEntry?.timer) clearInterval(firstEntry.timer)
  }
})

test('6: expiry clears the card and its interval \u2014 no orphaned setInterval', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let started = 0
  let cleared = 0
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (...args) => {
    started += 1
    return realSetInterval(...args)
  }
  globalThis.clearInterval = (...args) => {
    cleared += 1
    return realClearInterval(...args)
  }
  try {
    const { panel } = newPanel()
    panel._addConfirmCard(request({ expires_at: Date.now() + 5000 }))
    assert.equal(panel.cards.size, 1)
    assert.equal(started, 1)

    t.mock.timers.tick(5000)
    assert.equal(panel.cards.size, 0, 'the card is gone once it expires')
    assert.equal(cleared, 1, 'its interval was cleared exactly once \u2014 nothing orphaned')

    // Advancing further must not throw or do anything further — proof the timer is really gone.
    t.mock.timers.tick(60_000)
    assert.equal(started, 1)
    assert.equal(cleared, 1)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

// ── M-8: a finished card is cleared out of `this.cards`, so the map can empty again ─────────

test('M-8: a finished card is removed once its outcome has had its time on screen, so a later confirm signal can show the placeholder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  let fetchOk = false
  const { container, panel } = newPanel({
    answerConfirmation: async () => ({ status: 'confirmed', text: 'Moved "export.zip" to the Trash.' }),
    pendingConfirmations: async () => (fetchOk ? { ok: true, requests: [] } : { ok: false, requests: [] }),
  })
  panel._addConfirmCard(request({ expires_at: Date.now() + 60_000 }))
  const entry = panel.cards.get('c_1')

  entry.yesBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(entry.card.state, 'done')
  assert.equal(panel.cards.size, 1, 'still on screen right after finishing')

  t.mock.timers.tick(7999)
  assert.equal(panel.cards.size, 1, 'not removed a moment early')

  t.mock.timers.tick(1)
  assert.equal(panel.cards.size, 0, 'removed once the outcome has had its time on screen')
  assert.equal(container.children.length, 0, 'the finished card\u2019s element is gone too')

  // Now a later confirm signal that fails outright must be able to show the placeholder again —
  // impossible before the fix, since `this.cards.size` would never have returned to 0.
  await panel.refreshConfirmations()
  assert.equal(container.children.length, 1)
  assert.equal(container.children[0].className, 'j-confirm-placeholder')
  assert.equal(container.children[0].textContent, "I can't reach the assistant to show the card.")
})

test('M-8: a finished card\u2019s id arriving again in a later pending list is not re-added as a duplicate while its outcome is still on screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  let requests = []
  const { panel } = newPanel({
    answerConfirmation: async () => ({ status: 'confirmed', text: 'Done.' }),
    pendingConfirmations: async () => ({ ok: true, requests }),
  })
  panel._addConfirmCard(request({ expires_at: Date.now() + 60_000 }))
  const entry = panel.cards.get('c_1')

  entry.yesBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(entry.card.state, 'done')

  // The same request id shows up again in a later pending list before the outcome's time on
  // screen is up — e.g. a race with the gateway not yet having pruned it.
  requests = [request({ expires_at: Date.now() + 60_000 })]
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 1, 'not re-added \u2014 the finished entry is still showing')
  assert.equal(panel.cards.get('c_1'), entry, 'the same finished entry, not a fresh one')

  // Once its time is up, it really is gone, and a later sighting of the same id is fair game.
  t.mock.timers.tick(FINISHED_VISIBLE_MS)
  assert.equal(panel.cards.size, 0)
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 1, 'a fresh card for the same id is added once the old one is gone')
  assert.notEqual(panel.cards.get('c_1'), entry)
})

// ── item 7: the placeholder, and the "unreachable" retry path ───────────────────────────────

test('7: a confirm signal that fails outright renders the "can\'t reach it" placeholder', async () => {
  const { container, panel } = newPanel({ pendingConfirmations: async () => ({ ok: false, requests: [] }) })
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 0)
  assert.equal(container.children.length, 1)
  assert.equal(container.children[0].className, 'j-confirm-placeholder')
  assert.equal(container.children[0].textContent, "I can't reach the assistant to show the card.")
  assert.equal(container.children[0].getAttribute('aria-live'), 'polite')
})

test('7: a confirm signal that succeeds but comes back empty also renders the placeholder', async () => {
  const { container, panel } = newPanel({ pendingConfirmations: async () => ({ ok: true, requests: [] }) })
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 0)
  assert.equal(container.children[0].className, 'j-confirm-placeholder')
})

test('7: a successful fetch with a card clears any placeholder and shows the card instead', async () => {
  let ok = false
  const { container, panel } = newPanel({
    pendingConfirmations: async () => (ok ? { ok: true, requests: [request()] } : { ok: false, requests: [] }),
  })
  await panel.refreshConfirmations()
  assert.equal(container.children[0].className, 'j-confirm-placeholder')

  ok = true
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 1)
  assert.ok(!container.children.some((c) => c.className === 'j-confirm-placeholder'), 'the placeholder is gone once a card is up')
})

test('7: an already-shown card is left alone when a later refresh fails or comes back empty', async () => {
  let ok = true
  const { panel } = newPanel({
    pendingConfirmations: async () => (ok ? { ok: true, requests: [request()] } : { ok: false, requests: [] }),
  })
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 1)
  const entry = panel.cards.get('c_1')

  ok = false
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 1, 'the card already on screen is not replaced by a placeholder')
  assert.equal(panel.cards.get('c_1'), entry)
})

test('7: a POST that never reaches the assistant keeps the card answerable \u2014 nonce not nulled, buttons re-enabled', async (t) => {
  const secretNonce = 'SECRET-NONCE-retry-path-4d5e6f'
  const posted = []
  let firstAttempt = true
  const { panel } = newPanel({
    answerConfirmation: async (body) => {
      posted.push(body)
      if (firstAttempt) {
        firstAttempt = false
        // I2: this is what jarvis.js\u2019s answerConfirmation actually returns once the POST was
        // sent and then failed \u2014 the panel must show exactly this, not a fixed line of its own,
        // since the action may already have run and "can't reach the assistant" would be wrong.
        return { status: 'unreachable', text: "I didn't hear back, so I can't tell if that went through." }
      }
      return { status: 'confirmed', text: 'Moved "export.zip" to the Trash.' }
    },
  })
  panel._addConfirmCard(request({ nonce: secretNonce, expires_at: Date.now() + 60_000 }))
  const entry = panel.cards.get('c_1')

  entry.yesBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(posted.length, 1)
  assert.equal(posted[0].nonce, secretNonce)
  assert.equal(entry.card.state, 'idle', 'reverted to idle \u2014 still answerable')
  assert.equal(entry.noBtn.disabled, false)
  assert.equal(entry.yesBtn.disabled, false)
  assert.equal(entry.retryEl.hidden, false)
  assert.equal(entry.retryEl.textContent, "I didn't hear back, so I can't tell if that went through.", 'I2: the card shows the server call\u2019s own text, not a fixed "can\u2019t reach it" line')
  assert.ok(panel.cards.has('c_1'), 'the card is still there, not finished')

  // Retry: same nonce goes out again, and this time it's a real answer that finishes the card.
  entry.yesBtn.dispatch('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(posted.length, 2)
  assert.equal(posted[1].nonce, secretNonce, 'the retry uses the very same nonce \u2014 it was never spent')
  assert.equal(entry.card.state, 'done')
  assert.equal(entry.outcomeEl.textContent, 'Moved "export.zip" to the Trash.')
})

test('7: any real answer (confirmed/declined/expired/unknown/refused) finishes the card as today', async () => {
  for (const status of ['confirmed', 'declined', 'expired', 'unknown', 'refused']) {
    const { panel } = newPanel({ answerConfirmation: async () => ({ status, text: `outcome:${status}` }) })
    panel._addConfirmCard(request())
    const entry = panel.cards.get('c_1')
    entry.noBtn.dispatch('click')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(entry.card.state, 'done', `status ${status} must finish the card`)
    assert.equal(entry.outcomeEl.textContent, `outcome:${status}`)
  }
})

// ── item 8: accessibility ────────────────────────────────────────────────────────────────

test('8: role=group, aria-label from the summary, aria-describedby on both buttons, aria-live on the outcome', () => {
  const { panel } = newPanel()
  panel._addConfirmCard(request({ action: { tool: 'files.trash', summary: 'Trash the old export?', risk: 'delete' } }))
  const entry = panel.cards.get('c_1')

  assert.equal(entry.el.getAttribute('role'), 'group')
  assert.equal(entry.el.getAttribute('aria-label'), 'Trash the old export?')
  const summaryId = entry.el.querySelector('.c-summary').id
  assert.ok(summaryId)
  assert.equal(entry.noBtn.getAttribute('aria-describedby'), summaryId)
  assert.equal(entry.yesBtn.getAttribute('aria-describedby'), summaryId)
  assert.equal(entry.outcomeEl.getAttribute('aria-live'), 'polite')
  assert.equal(entry.retryEl.getAttribute('aria-live'), 'polite')
})

test('8: the visible countdown is not a live region \u2014 only the visually-hidden span announces, and only at 30s/10s', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { panel } = newPanel()
  panel._addConfirmCard(request({ expires_at: Date.now() + 35_000 }))
  const entry = panel.cards.get('c_1')

  assert.equal(entry.countdownEl.getAttribute('aria-live'), null, 'the ticking countdown itself must not be a live region')
  assert.equal(entry.liveEl.getAttribute('aria-live'), 'polite')
  assert.equal(entry.liveEl.className, 'sr-only c-announce')
  assert.equal(entry.liveEl.textContent, '', 'nothing announced yet with 35s left')

  const seenAnnouncements = []
  const originalDescriptor = Object.getOwnPropertyDescriptor(entry.liveEl, 'textContent')
  // Track every write to the live region's text without changing its behaviour.
  Object.defineProperty(entry.liveEl, 'textContent', {
    get: originalDescriptor.get,
    set(v) {
      seenAnnouncements.push(v)
      originalDescriptor.set.call(entry.liveEl, v)
    },
  })

  t.mock.timers.tick(30_000) // ticks at 34s,33s,...,5s left — crosses 30s and 10s along the way
  assert.deepEqual(seenAnnouncements, ['30 seconds left to respond', '10 seconds left to respond'])
})

test('8: default focus lands on No for the first card only \u2014 a second card must not steal it', () => {
  const { panel } = newPanel()
  panel._addConfirmCard(request({ request_id: 'c_1' }))
  panel._addConfirmCard(request({ request_id: 'c_2' }))
  assert.equal(panel.cards.get('c_1').noBtn._focused, true)
  assert.equal(panel.cards.get('c_2').noBtn._focused, false)
})

test('8: an adversarial summary/risk is never turned into markup \u2014 stored and labelled as inert text', () => {
  const summary = '<img src=x onerror=alert(1)>.csv'
  const risk = '"><script>alert(1)</script>'
  const { document, panel } = newPanel()
  panel._addConfirmCard(request({ action: { tool: 'files.trash', summary, risk } }))
  const entry = panel.cards.get('c_1')

  assert.equal(entry.el.querySelector('.c-summary').textContent, summary)
  assert.equal(entry.el.querySelector('.c-risk').textContent, risk)
  assert.equal(entry.el.getAttribute('aria-label'), summary)

  // No element anywhere in the card's tree was actually created from that text — it never
  // went through anything that parses HTML, so there is no <img> or <script> node to find.
  const tags = []
  const collect = (node) => {
    tags.push(node.tagName)
    for (const c of node.children) collect(c)
  }
  collect(entry.el)
  assert.ok(!tags.includes('IMG'))
  assert.ok(!tags.includes('SCRIPT'))

  // M-9: the escaping this test relies on is the live path\u2019s own, not a separate one proved
  // only by `cardMarkup()`\u2019s now-removed tests. Nothing the panel does may ever assign
  // `innerHTML` \u2014 the fake DOM records every write anywhere in the document, so this is a
  // whole-panel guarantee, not just a check of the summary/risk fields above.
  assert.equal(document.innerHTMLWrites.length, 0, 'nothing in the panel ever assigns innerHTML')
})

// \u2500\u2500 I1 (fix round 1): the injected setTimeout/clearTimeout must be called unbound \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// A real browser's `setTimeout`/`clearTimeout` are WebIDL operations on `Window`: calling them as
// `this._setTimeout(...)` invokes them with the panel instance as `this`, and a receiver that is
// not `Window` (or `undefined`) is refused with "TypeError: Illegal invocation". Node's own
// `setTimeout` does not check `this` at all, which is why the panel's other tests all passed
// before this fix even though the panel would have broken in Chromium the moment a card finished.
// This fake reproduces the browser's check directly, without needing a real browser: it throws
// unless it is called unbound (`this` is `undefined`, since this module is strict) or explicitly
// with `globalThis` as the receiver.

function webIdlLikeTimer(impl) {
  return function (...args) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'setTimeout' on 'Window': Illegal invocation")
    }
    return impl(...args)
  }
}

test('I1: scheduling a finished card\u2019s cleanup calls setTimeoutImpl unbound, not as this._setTimeout(...)', () => {
  const { panel } = newPanel({
    setTimeoutImpl: webIdlLikeTimer(() => 'fake-timer-id'),
    clearTimeoutImpl: webIdlLikeTimer(() => {}),
  })
  panel._addConfirmCard(request())
  const entry = panel.cards.get('c_1')
  // Force straight to DONE without going through the real answer() flow (which would also clear
  // this) \u2014 clear the countdown's own real setInterval by hand so this test leaks nothing.
  if (entry.timer) {
    clearInterval(entry.timer)
    entry.timer = null
  }
  entry.card = { ...entry.card, state: CARD_STATES.DONE, text: 'Done.' }

  assert.doesNotThrow(
    () => panel._renderConfirmOutcome(entry),
    'a real browser\u2019s setTimeout refuses a `this` that is not the window \u2014 the panel must never call it as this._setTimeout(...)',
  )
})

test('I1: clearing a finished card\u2019s timer calls clearTimeoutImpl unbound, not as this._clearTimeout(...)', () => {
  const { panel } = newPanel({
    setTimeoutImpl: webIdlLikeTimer(() => 'fake-timer-id'),
    clearTimeoutImpl: webIdlLikeTimer(() => {}),
  })
  panel._addConfirmCard(request())
  const entry = panel.cards.get('c_1')
  if (entry.timer) {
    clearInterval(entry.timer)
    entry.timer = null
  }
  entry.card = { ...entry.card, state: CARD_STATES.DONE, text: 'Done.' }
  panel._renderConfirmOutcome(entry)

  assert.doesNotThrow(
    () => panel._removeFinishedCard(entry.card.requestId),
    'a real browser\u2019s clearTimeout refuses a `this` that is not the window \u2014 the panel must never call it as this._clearTimeout(...)',
  )
  assert.equal(panel.cards.size, 0, 'the card was still removed \u2014 the fix does not skip the cleanup, only the receiver')
})

// -- Gate G5 (04.10.26): a card the server already settled leaves the screen ----------------------
//
// Live evidence: "cancel it" said by voice with a card up. The assistant declined the card on
// the server and said "Okay, cancelled.", but the card stayed drawn in the window. `_doRefresh` only
// ever ADDED cards, and a card left the screen only when it was answered on the panel itself or its
// own countdown ran out. Now every SUCCESSFUL fetch of the pending list also takes off any card that
// is still idle and no longer listed, and main.js asks for one after every answer with
// `{ expectCard: false }` -- a reconcile-only refresh. Nothing pending is then no business of the
// "can't reach it" placeholder, which stays for a confirm signal that promised a card.

/** A pending-list stub a test can change between refreshes, counting how many fetches were made. */
const livePending = (initial = []) => {
  const state = { requests: initial, ok: true, calls: 0 }
  state.fetch = async () => {
    state.calls += 1
    return state.ok ? { ok: true, requests: state.requests } : { ok: false, requests: [] }
  }
  return state
}

const hasPlaceholder = (container) => container.children.some((c) => c.className === 'j-confirm-placeholder')
const CANT_SHOW_TEXT = "I can't reach the assistant to show the card."
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('Gate G5 (04.10.26): a card the server already settled is removed by an answer-triggered refresh, and no placeholder takes its place', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const pending = livePending([request()])
  const { container, panel } = newPanel({ pendingConfirmations: pending.fetch })
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 1)
  assert.equal(container.children.length, 1)

  pending.requests = [] // "cancel it": the assistant declined the card on the server
  await panel.refreshConfirmations({ expectCard: false })
  assert.equal(panel.cards.size, 0, 'the card is off the screen')
  assert.equal(container.children.length, 0, 'its element is gone, and nothing (no placeholder) took its place')
})

test('Gate G5 (04.10.26): a card removed because the server settled it stops ticking and can no longer be answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const answered = []
  const pending = livePending([request()])
  const { panel } = newPanel({
    pendingConfirmations: pending.fetch,
    answerConfirmation: async (body) => {
      answered.push(body)
      return { status: 'confirmed', text: 'Done.' }
    },
  })
  await panel.refreshConfirmations()
  const entry = panel.cards.get('c_1')
  assert.ok(entry.timer, 'its countdown is ticking while it is up')

  pending.requests = []
  await panel.refreshConfirmations({ expectCard: false })
  assert.equal(entry.timer, null, 'its countdown interval was cleared -- nothing orphaned')
  t.mock.timers.tick(120_000)
  assert.equal(panel.cards.size, 0, 'and nothing brings it back')

  // A stray click on a button that is no longer on screen goes nowhere: nothing is sent, nonce included.
  entry.yesBtn.dispatch('click')
  entry.noBtn.dispatch('click')
  await tick()
  assert.deepEqual(answered, [])
})

test('Gate G5 (04.10.26): a card mid-answer is not removed even though the server no longer lists it -- its own answer flow finishes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  let resolveAnswer
  const { container, panel } = newPanel({
    pendingConfirmations: async () => ({ ok: true, requests: [] }),
    answerConfirmation: () =>
      new Promise((resolve) => {
        resolveAnswer = resolve
      }),
  })
  panel._addConfirmCard(request({ expires_at: Date.now() + 60_000 }))
  const entry = panel.cards.get('c_1')
  entry.yesBtn.dispatch('click') // the POST is in flight; the server has already consumed the request
  assert.equal(entry.card.state, 'sending')

  await panel.refreshConfirmations({ expectCard: false })
  assert.equal(panel.cards.get('c_1'), entry, 'still the same entry')
  assert.equal(container.children.length, 1, 'still on screen, and no placeholder beside it')

  resolveAnswer({ status: 'confirmed', text: 'Moved "export.zip" to the Trash.' })
  await tick()
  assert.equal(entry.card.state, 'done', 'its own flow finished it')
  assert.equal(entry.outcomeEl.textContent, 'Moved "export.zip" to the Trash.')
})

test('Gate G5 (04.10.26): a finished card is not removed by a reconcile either -- its outcome clears on its own timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const pending = livePending([request({ expires_at: Date.now() + 60_000 })])
  const { container, panel } = newPanel({ pendingConfirmations: pending.fetch })
  await panel.refreshConfirmations()
  const entry = panel.cards.get('c_1')
  entry.yesBtn.dispatch('click')
  await tick()
  assert.equal(entry.card.state, 'done')

  pending.requests = [] // the answered request is gone from the server's list, as it always is
  await panel.refreshConfirmations({ expectCard: false })
  assert.equal(panel.cards.get('c_1'), entry, 'the finished entry is left alone')
  assert.equal(entry.outcomeEl.hidden, false, 'its outcome is still showing')
  assert.equal(entry.outcomeEl.textContent, 'Done.')
  assert.equal(container.children.length, 1)

  t.mock.timers.tick(FINISHED_VISIBLE_MS)
  assert.equal(panel.cards.size, 0, 'it clears on its own timer, as before')
})

test('Gate G5 (04.10.26): a fetch that fails or comes back malformed removes nothing, and shows no placeholder for an ordinary answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const shapes = {
    'not ok': async () => ({ ok: false, requests: [] }),
    'rejects': async () => {
      throw new Error('network down')
    },
    'ok but no list': async () => ({ ok: true }),
    'ok but not a list': async () => ({ ok: true, requests: 'nope' }),
  }
  for (const [name, shape] of Object.entries(shapes)) {
    for (const options of [{ expectCard: false }, undefined]) {
      let next = async () => ({ ok: true, requests: [request()] })
      const { container, panel } = newPanel({ pendingConfirmations: () => next() })
      await panel.refreshConfirmations()
      const entry = panel.cards.get('c_1')
      assert.ok(entry, `${name}: the card went up`)

      next = shape
      await panel.refreshConfirmations(options)
      const label = `${name}, ${JSON.stringify(options)}`
      assert.equal(panel.cards.get('c_1'), entry, `${label}: the card on screen is untouched`)
      assert.equal(container.children.length, 1, `${label}: only the card is on screen -- no placeholder`)
      assert.equal(entry.card.state, 'idle', `${label}: still answerable`)
    }
  }
})

test('Gate G5 (04.10.26): an answer-triggered refresh that finds nothing pending shows no placeholder', async () => {
  for (const result of [{ ok: true, requests: [] }, { ok: false, requests: [] }]) {
    const { container, panel } = newPanel({ pendingConfirmations: async () => result })
    await panel.refreshConfirmations({ expectCard: false })
    assert.equal(panel.cards.size, 0)
    assert.equal(container.children.length, 0, `ok=${result.ok}: nothing was promised, so nothing is said`)
  }
})

test('Gate G5 (04.10.26): a confirm-promised refresh with nothing pending still shows the placeholder, asked for explicitly or by default', async () => {
  for (const options of [{ expectCard: true }, {}, undefined]) {
    for (const result of [{ ok: true, requests: [] }, { ok: false, requests: [] }]) {
      const { container, panel } = newPanel({ pendingConfirmations: async () => result })
      await panel.refreshConfirmations(options)
      assert.equal(container.children.length, 1, `${JSON.stringify(options)} ok=${result.ok}`)
      assert.equal(container.children[0].className, 'j-confirm-placeholder')
      assert.equal(container.children[0].textContent, CANT_SHOW_TEXT)
    }
  }
})

test('Gate G5 (04.10.26): a confirm-promised refresh also reconciles -- a settled card goes, and if the promised card is not there either, the placeholder shows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const pending = livePending([request()])
  const { container, panel } = newPanel({ pendingConfirmations: pending.fetch })
  await panel.refreshConfirmations()
  assert.equal(panel.cards.size, 1)

  pending.requests = [] // the old card was settled, and the one the signal promised has already gone too
  await panel.refreshConfirmations({ expectCard: true })
  assert.equal(panel.cards.size, 0, 'the settled card is gone')
  assert.ok(hasPlaceholder(container), 'nothing is on screen for the card that was promised')
})

test('Gate G5 (04.10.26): a confirm-promised call joining a reconcile-only fetch already in flight still gets the placeholder, with one GET only (ruling 6)', async () => {
  let fetchCalls = 0
  let resolveFetch
  const { container, panel } = newPanel({
    pendingConfirmations: () =>
      new Promise((resolve) => {
        fetchCalls += 1
        resolveFetch = resolve
      }),
  })
  const reconcileOnly = panel.refreshConfirmations({ expectCard: false })
  const promised = panel.refreshConfirmations({ expectCard: true }) // must join the fetch, not start a second one
  assert.equal(fetchCalls, 1, 'still never more than one GET outstanding')
  resolveFetch({ ok: true, requests: [] })
  await Promise.all([reconcileOnly, promised])
  assert.ok(hasPlaceholder(container), 'the promise was not lost by joining a fetch that started without it')
})

test('Gate G5 (04.10.26): a reconcile-only call joining a confirm-promised fetch already in flight does not downgrade it', async () => {
  let fetchCalls = 0
  let resolveFetch
  const { container, panel } = newPanel({
    pendingConfirmations: () =>
      new Promise((resolve) => {
        fetchCalls += 1
        resolveFetch = resolve
      }),
  })
  const promised = panel.refreshConfirmations({ expectCard: true })
  const reconcileOnly = panel.refreshConfirmations({ expectCard: false })
  assert.equal(fetchCalls, 1)
  resolveFetch({ ok: true, requests: [] })
  await Promise.all([promised, reconcileOnly])
  assert.ok(hasPlaceholder(container), 'the mid-stream confirm signal still gets its placeholder')
})

test('Gate G5 (04.10.26): what a refresh expects is not sticky -- the next one starts from its own option', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const pending = livePending([request()])
  const { container, panel } = newPanel({ pendingConfirmations: pending.fetch })
  await Promise.all([panel.refreshConfirmations({ expectCard: true }), panel.refreshConfirmations({ expectCard: false })])
  assert.equal(pending.calls, 1, 'the two overlapping calls shared one fetch')
  assert.equal(panel.cards.size, 1)

  pending.requests = []
  await panel.refreshConfirmations({ expectCard: false })
  assert.equal(pending.calls, 2, 'a fresh fetch once the first had landed')
  assert.equal(panel.cards.size, 0)
  assert.equal(container.children.length, 0, 'no placeholder -- the earlier promise was not carried over into this refresh')
})

test('Gate G5 (04.10.26): only the settled card goes -- another still pending keeps its entry and its countdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const other = request({ request_id: 'c_2', action: { tool: 'files.trash', summary: 'Trash the other export?', risk: 'delete' } })
  const pending = livePending([request({ request_id: 'c_1' }), other])
  const { container, panel } = newPanel({ pendingConfirmations: pending.fetch })
  await panel.refreshConfirmations()
  const second = panel.cards.get('c_2')
  assert.equal(panel.cards.size, 2)

  pending.requests = [other]
  await panel.refreshConfirmations({ expectCard: false })
  assert.equal(panel.cards.has('c_1'), false, 'the settled card is gone')
  assert.equal(panel.cards.get('c_2'), second, 'the one still pending is the very same entry')
  assert.ok(second.timer, 'and still ticking')
  assert.equal(container.children.length, 1)
  assert.equal(container.children[0], second.el)
})

test('Gate G5 (04.10.26): one refresh can take off a settled card and put up a new one, and the new one takes the default focus on No', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const pending = livePending([request({ request_id: 'c_1' })])
  const { container, panel } = newPanel({ pendingConfirmations: pending.fetch })
  await panel.refreshConfirmations()

  pending.requests = [request({ request_id: 'c_2' })]
  await panel.refreshConfirmations({ expectCard: false })
  assert.deepEqual([...panel.cards.keys()], ['c_2'])
  assert.equal(container.children.length, 1)
  assert.equal(panel.cards.get('c_2').noBtn._focused, true, 'it is the first card on screen again, so it gets the default focus')
})
