/**
 * The confirmation card's DOM glue — one small, injectable seam pulled out of `hud.js`.
 *
 * `hud.js` builds the rest of the panel straight against the real browser (`navigator`,
 * `matchMedia`, three.js face-atlas canvases, a template string rendered once at construction) and
 * there is no fake worth writing for all of that. This file is the one part of the confirm-card
 * feature that is small enough to fake: it takes a `document` and a container element and does
 * nothing else browser-specific, so a test can hand it a minimal fake `document` (see
 * `test/support/fake-dom.mjs`) and drive it directly. `hud.js` is just a caller — it builds one
 * `ConfirmPanel` against its own `.j-confirms` container and forwards `refreshConfirmations()`.
 *
 * Security invariant (contract §14 / ruling B2 — CRITICAL): a card's one-shot `nonce` never
 * leaves this file's own closures, and never touches anything a caller could walk or serialise.
 * `_addConfirmCard` reads `request.nonce` into a `let nonce` local the moment a card is created;
 * that local is captured only by the two button click handlers defined in the same call, and is
 * set back to `null` the instant it is spent — the one POST that actually reaches the assistant
 * and gets a real (non-`unreachable`) answer back. `createCard()` (confirm-cards.js) never sees
 * the nonce at all, `entry` (what this instance stores in `this.cards`) never holds it, and
 * nothing this file writes to an element ever carries it — not an attribute, not an id, not a
 * log call. Recursively walking a `ConfirmPanel` instance, or `hud`, or the object `main.js` puts
 * on `window`, finds it nowhere; see `test/confirm-panel.test.mjs`.
 */
import {
  CARD_STATES,
  countdownText,
  createCard,
  markDone,
  markExpired,
  markSending,
  markUnreachable,
  newRequests,
  staleRequestIds,
} from '../game/confirm-cards.js'
import {
  answerConfirmation as defaultAnswerConfirmation,
  pendingConfirmationsDetailed as defaultPendingConfirmationsDetailed,
} from '../game/jarvis.js'

/** Shown when a `confirm` signal promised a card and nothing ends up on screen for it (item 7). */
const CANT_SHOW = "I can't reach the assistant to show the card."
/**
 * Fallback only (I2): the card shows `result.text` from `answerConfirmation` itself, since
 * jarvis.js already tells apart "never even sent" from "sent, but no answer came back" and words
 * each one correctly — saying a fixed "can't reach it" line here regardless would undo that
 * distinction right where it matters (the action may already have run). This is used only if a
 * caller's `answerConfirmation` somehow returns no text at all.
 */
const RETRY_LINE = "I couldn't reach the assistant. Try again."
/** The visible countdown ticks every second; the screen-reader announcement fires only here. */
const ANNOUNCE_AT = [30, 10]
/**
 * How long a finished card's outcome stays on screen before it is cleared out of `this.cards`
 * (M-8). Without this, a card that reaches DONE stays in the map forever: `this.cards.size`
 * never returns to 0, so the "I can't reach the assistant to show the card." placeholder (item 7)
 * can never appear again for a later card in the same session.
 */
export const FINISHED_VISIBLE_MS = 8000

export class ConfirmPanel {
  constructor({
    document: doc = globalThis.document,
    container,
    pendingConfirmations = defaultPendingConfirmationsDetailed,
    answerConfirmation = defaultAnswerConfirmation,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  }) {
    this.document = doc
    this.container = container
    this._pendingConfirmations = pendingConfirmations
    this._answerConfirmation = answerConfirmation
    this._setTimeout = setTimeoutImpl
    this._clearTimeout = clearTimeoutImpl
    // requestId -> { el, card, timer, finishTimer, announced, noBtn, yesBtn, countdownEl, liveEl,
    // retryEl, outcomeEl }. No nonce field, ever — see the header.
    this.cards = new Map()
    this._refreshInFlight = null
    // Whether the fetch in flight (or the next one) was promised a card -- see refreshConfirmations().
    this._expectCard = true
    this._placeholderEl = null
  }

  // ── fetching ──────────────────────────────────────────────────────────────────────────

  /**
   * Fetches the assistant's pending confirmations and adds a card for every one not already on
   * screen. `main.js` calls this once mid-stream (`onConfirm`) and again on the final reply
   * (`reply.action === 'confirm'`) for the *same* card (ruling 6): an in-flight guard collapses an
   * overlapping second call into the one fetch already running, so there is never more than one
   * `GET /v1/confirm` outstanding, and so never two attempts racing to add the same card.
   *
   * Gate G5 (04.10.26): a fetch that SUCCEEDS also takes off any card still waiting for a click
   * that the assistant no longer lists (answered some other way, or expired on its side), and
   * `main.js` now calls this after every answer, typed or spoken, not just a `confirm` one.
   * `expectCard` tells the two kinds of call apart: a `confirm` signal promised a card, so it is
   * the default and keeps the old behaviour (nothing on screen once the fetch lands means the
   * "can't reach it" placeholder); an ordinary answer passes `{ expectCard: false }` and gets a
   * reconcile-only refresh that never shows the placeholder, since nothing was promised. A call
   * that joins a fetch already in flight can only RAISE what that fetch expects, never lower it,
   * so a mid-stream `confirm` signal is not downgraded by an ordinary answer landing on top of it.
   */
  refreshConfirmations({ expectCard = true } = {}) {
    if (this._refreshInFlight) {
      this._expectCard = this._expectCard || expectCard
      return this._refreshInFlight
    }
    this._expectCard = expectCard
    this._refreshInFlight = this._doRefresh().finally(() => {
      this._refreshInFlight = null
    })
    return this._refreshInFlight
  }

  async _doRefresh() {
    let result
    try {
      result = await this._pendingConfirmations()
    } catch {
      result = { ok: false, requests: [] }
    }
    // Only a fetch that succeeded AND handed back a real list says anything about what is pending:
    // a failed or malformed one must never take a card off the screen.
    const requests = result?.ok && Array.isArray(result.requests) ? result.requests : null
    if (requests) {
      // Gate G5 (04.10.26): off first, then on, so a card that arrives in this same refresh counts
      // as the first on screen again (the default focus). Only a card still idle goes -- one
      // mid-answer or already showing its outcome is left to its own flow -- and it goes through
      // the same teardown as an expiry: its interval cleared, its element removed, and shut to
      // answers first, so a click that somehow reached its detached buttons sends nothing.
      const models = Array.from(this.cards.values(), (entry) => entry.card)
      for (const id of staleRequestIds(requests, models)) this._expireConfirmCard(id)
      for (const request of newRequests(requests, new Set(this.cards.keys()))) this._addConfirmCard(request)
    }
    // A `confirm` signal promised a card. If nothing is on screen once this fetch has landed —
    // it failed outright, or it succeeded but came back with nothing (a race with the request
    // already having been answered or expired elsewhere) — say so, rather than leaving the panel
    // looking like the click never happened. A card already showing is left alone either way.
    // An ordinary answer promised nothing (Gate G5): an empty panel after one is just an empty
    // panel, so it never raises the placeholder (a card showing still clears it, as ever).
    if (this.cards.size > 0) this._clearPlaceholder()
    else if (this._expectCard) this._showPlaceholder(CANT_SHOW)
  }

  _showPlaceholder(text) {
    if (!this.container) return
    if (!this._placeholderEl) {
      const el = this.document.createElement('div')
      el.className = 'j-confirm-placeholder'
      el.setAttribute('aria-live', 'polite')
      this.container.appendChild(el)
      this._placeholderEl = el
    }
    this._placeholderEl.textContent = text
  }

  _clearPlaceholder() {
    if (!this._placeholderEl) return
    this._placeholderEl.remove()
    this._placeholderEl = null
  }

  // ── one card ──────────────────────────────────────────────────────────────────────────

  _addConfirmCard(request) {
    if (!this.container) return
    if (this.cards.has(request.request_id)) return // no double-add on a raced/overlapping refresh
    this._clearPlaceholder()

    // The nonce lives here, and only here: a closure local, read by the `answer` closure below
    // (itself reachable only from the two button click handlers), and nulled the instant it is
    // spent. `createCard` below never receives it.
    let nonce = request.nonce
    const isFirstCard = this.cards.size === 0
    const card = createCard(request)

    const el = this.document.createElement('div')
    el.className = 'j-confirm'
    el.setAttribute('role', 'group')
    // Plain attribute assignment — never string-concatenated into markup — so an adversarial
    // summary (`<img src=x onerror=…>`, `">…`) lands as inert attribute text, never as HTML.
    el.setAttribute('aria-label', card.summary)

    const summaryEl = this.document.createElement('div')
    summaryEl.className = 'c-summary'
    summaryEl.id = `confirm-summary-${card.requestId}`
    summaryEl.textContent = card.summary
    el.appendChild(summaryEl)

    const riskEl = this.document.createElement('div')
    riskEl.className = 'c-risk'
    riskEl.textContent = card.risk
    el.appendChild(riskEl)

    const countdownEl = this.document.createElement('div')
    countdownEl.className = 'c-countdown'
    countdownEl.textContent = countdownText(card.expiresAt)
    el.appendChild(countdownEl)

    // Visually hidden and separate from the visible countdown on purpose (item 8): nobody wants
    // "58s left, 57s left, 56s left…" read aloud every second. This announces only at 30s and 10s.
    const liveEl = this.document.createElement('span')
    liveEl.className = 'sr-only c-announce'
    liveEl.setAttribute('aria-live', 'polite')
    el.appendChild(liveEl)

    const actions = this.document.createElement('div')
    actions.className = 'c-actions'
    const noBtn = this._button('No', ['btn', 'c-no'], summaryEl.id)
    const yesBtn = this._button('Yes', ['btn', 'primary', 'c-yes'], summaryEl.id)
    actions.appendChild(noBtn)
    actions.appendChild(yesBtn)
    el.appendChild(actions)

    // A transient line for "that POST never reached the assistant" (item 7) — the card stays up
    // and answerable, so this sits beside the buttons rather than replacing them.
    const retryEl = this.document.createElement('div')
    retryEl.className = 'c-retry'
    retryEl.setAttribute('aria-live', 'polite')
    retryEl.hidden = true
    el.appendChild(retryEl)

    const outcomeEl = this.document.createElement('div')
    outcomeEl.className = 'c-outcome'
    outcomeEl.setAttribute('aria-live', 'polite')
    outcomeEl.hidden = true
    el.appendChild(outcomeEl)

    this.container.appendChild(el)

    const entry = { el, card, timer: null, finishTimer: null, announced: new Set(), countdownEl, liveEl, retryEl, outcomeEl, noBtn, yesBtn }
    this.cards.set(card.requestId, entry)
    this._startTicking(entry)

    const answer = async (decision) => {
      if (entry.card.state !== CARD_STATES.IDLE) return // no double-send on a double-click
      entry.card = markSending(entry.card)
      entry.retryEl.hidden = true
      if (entry.timer) {
        clearInterval(entry.timer)
        entry.timer = null
      }
      entry.noBtn.disabled = true
      entry.yesBtn.disabled = true

      const result = await this._answerConfirmation({ request_id: card.requestId, nonce, decision })

      // The card may be gone already (panel closed and reopened, or it expired mid-flight) —
      // guard rather than write into a detached element.
      if (!this.cards.has(card.requestId)) return

      if (result.status === 'unreachable') {
        // Nothing was spent — the nonce this card was created with is still good, and the card
        // stays answerable until it actually expires (item 7). I2: show the caller's own text —
        // jarvis.js already words "never sent" and "sent, but no answer came back" differently,
        // and only it knows which one happened.
        entry.card = markUnreachable(entry.card)
        entry.retryEl.textContent = result.text || RETRY_LINE
        entry.retryEl.hidden = false
        entry.noBtn.disabled = false
        entry.yesBtn.disabled = false
        if (entry.card.state === CARD_STATES.IDLE) this._startTicking(entry)
        return
      }

      // A real answer came back — spent, one way or the other. The nonce this card was created
      // with must never be usable again.
      nonce = null
      entry.card = markDone(entry.card, result.text)
      this._renderConfirmOutcome(entry)
    }

    noBtn.addEventListener('click', () => answer('no'))
    yesBtn.addEventListener('click', () => answer('yes'))

    // The safe default: keyboard focus lands on No, and only for the first card to appear while
    // none was already showing — a card arriving after one is already up must not steal focus
    // from whatever the person is doing with it.
    if (isFirstCard) noBtn.focus()
  }

  _button(label, classes, describedBy) {
    const b = this.document.createElement('button')
    b.type = 'button'
    b.className = classes.join(' ')
    b.textContent = label
    // Ties both Yes and No back to the summary that says what they would be agreeing to.
    b.setAttribute('aria-describedby', describedBy)
    return b
  }

  _startTicking(entry) {
    const tick = () => {
      if (entry.card.state !== CARD_STATES.IDLE) return
      const text = countdownText(entry.card.expiresAt)
      entry.countdownEl.textContent = text
      const secsLeft = Math.max(0, Math.ceil((Number(entry.card.expiresAt) - Date.now()) / 1000))
      for (const mark of ANNOUNCE_AT) {
        if (secsLeft <= mark && !entry.announced.has(mark)) {
          entry.announced.add(mark)
          entry.liveEl.textContent = `${mark} seconds left to respond`
        }
      }
      if (text === 'Expired') this._expireConfirmCard(entry.card.requestId)
    }
    tick()
    if (entry.card.state === CARD_STATES.IDLE) entry.timer = setInterval(tick, 1000)
  }

  _renderConfirmOutcome(entry) {
    entry.outcomeEl.hidden = false
    entry.outcomeEl.textContent = entry.card.text
    entry.el.replaceChildren(entry.outcomeEl)
    // M-8: the outcome stays on screen for a short while, then the card is cleared out of
    // `this.cards` entirely — otherwise the map only ever grows, `this.cards.size` never
    // returns to 0, and a later `confirm` signal can never show the "can't reach it" placeholder.
    // I1: called unbound (a plain reference, not `this._setTimeout(...)`) — a real browser's
    // `setTimeout` is a WebIDL operation on `Window` and refuses a `this` that is not the window,
    // and calling it as a method of this panel instance throws "Illegal invocation" in Chromium
    // (Node's own `setTimeout` does not check `this`, which is how this went unnoticed).
    const scheduleTimeout = this._setTimeout
    entry.finishTimer = scheduleTimeout(() => this._removeFinishedCard(entry.card.requestId), FINISHED_VISIBLE_MS)
  }

  _removeFinishedCard(requestId) {
    const entry = this.cards.get(requestId)
    if (!entry) return
    if (entry.finishTimer) {
      // I1: same reasoning as above — called unbound, never as this._clearTimeout(...).
      const cancelTimeout = this._clearTimeout
      cancelTimeout(entry.finishTimer)
      entry.finishTimer = null
    }
    entry.el.remove()
    this.cards.delete(requestId)
  }

  _expireConfirmCard(requestId) {
    const entry = this.cards.get(requestId)
    if (!entry) return
    entry.card = markExpired(entry.card)
    if (entry.timer) {
      clearInterval(entry.timer)
      entry.timer = null
    }
    entry.el.remove()
    this.cards.delete(requestId)
  }
}
