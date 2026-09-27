/**
 * The assistant's confirmation cards, as pure data.
 *
 * A confirmation is a risky action the assistant will not take without a click: "trash the old
 * export?", "delete this for good?". The gateway hands back a list of pending ones over
 * `GET /v1/confirm` — each with a one-shot `nonce` that answers it — and every card in the panel
 * lives and dies by that list. This file is the part of that worth testing on its own: what state
 * a card is in, what its countdown reads, which of a fresh pending list are cards the panel has
 * not shown yet, and the HTML a card renders as (kept for its own documented shape and tests; the
 * live glue in `confirm-panel.js` builds its DOM directly rather than through this string, so it
 * never has to parse anything back out of it — see that file's header for why).
 *
 * No DOM here, and — since ruling B2 — no `nonce` anywhere in this file's model either: `createCard`
 * deliberately drops it. `confirm-panel.js` reads `request.nonce` into a closure local of its own,
 * the instant a card is created, and that local is the *only* place the nonce ever lives after
 * that: never on the card object this file returns, never on anything stored in a Map, never in an
 * attribute, an id, storage, or a console call. That is what makes a recursive walk of the panel
 * (or of anything `main.js` puts on `window`) come up empty for it.
 *
 * M-9: this file used to also export `cardMarkup()`, an HTML-string rendering of a card, kept
 * "for its own documented shape and tests". Nothing ever called it outside its own test file —
 * `confirm-panel.js` builds its DOM directly with `createElement`/`textContent`/`setAttribute` and
 * never parses a string back out of anything. Keeping `cardMarkup()`'s escaping tests green proved
 * an escaping path the live code never runs through, not the one it actually uses; removed, along
 * with its tests. The live path's escaping is proven in `test/confirm-panel.test.mjs` instead,
 * against the fake DOM's own `innerHTML` write log (see `test/support/fake-dom.mjs`).
 */

/** A card's lifecycle: waiting for a click, in flight after one, or settled — by an answer or by expiry. */
export const CARD_STATES = Object.freeze({ IDLE: 'idle', SENDING: 'sending', DONE: 'done', EXPIRED: 'expired' })

/**
 * A fresh card for one pending request, exactly as `pendingConfirmations()` returned it
 * (`{request_id, nonce, action:{tool, summary, risk}, expires_at}`) — minus the nonce itself,
 * which this function never copies onto the card. The caller (`confirm-panel.js`) still has
 * `request.nonce` in hand from the same object; it just never passes it in here.
 */
export function createCard(request) {
  return {
    requestId: request.request_id,
    tool: request.action?.tool || '',
    summary: request.action?.summary || '',
    risk: request.action?.risk || '',
    expiresAt: request.expires_at,
    state: CARD_STATES.IDLE,
    text: '',
  }
}

/** idle -> sending, on a Yes/No click. Any other state is left alone — no double-send. */
export function markSending(card) {
  return card.state === CARD_STATES.IDLE ? { ...card, state: CARD_STATES.SENDING } : card
}

/** sending -> done, once a real answer comes back. Only a card actually in flight can finish. */
export function markDone(card, text) {
  return card.state === CARD_STATES.SENDING ? { ...card, state: CARD_STATES.DONE, text } : card
}

/**
 * sending -> idle, when the POST never reached the assistant at all (no answer to show, nothing
 * spent). The card goes back to waiting for a click — same nonce, same expiry, still answerable —
 * rather than finishing on a failure that was never really an answer.
 */
export function markUnreachable(card) {
  return card.state === CARD_STATES.SENDING ? { ...card, state: CARD_STATES.IDLE } : card
}

/** idle -> expired, when the countdown reaches zero before anyone clicks. */
export function markExpired(card) {
  return card.state === CARD_STATES.IDLE ? { ...card, state: CARD_STATES.EXPIRED } : card
}

/** "45s left" down to "1s left", then "Expired" — never negative, never "0s left". */
export function countdownText(expiresAt, now = Date.now()) {
  const msLeft = Number(expiresAt) - now
  if (!Number.isFinite(msLeft) || msLeft <= 0) return 'Expired'
  const secs = Math.max(1, Math.ceil(msLeft / 1000))
  return `${secs}s left`
}

/** Only the requests not already on screen, in the order the assistant sent them. */
export function newRequests(pending, shownIds) {
  const shown = shownIds || new Set()
  return (pending || []).filter((r) => r && r.request_id && !shown.has(r.request_id))
}
