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
        return { status: 'unreachable', text: "I couldn't reach the assistant." }
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
  assert.equal(entry.retryEl.textContent, "I couldn't reach the assistant. Try again.")
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
