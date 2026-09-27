/**
 * The smallest fake DOM `confirm-panel.js` needs to run outside a browser.
 *
 * `hud.js` is too entangled with the real browser (navigator, matchMedia, three.js canvases, a
 * template string rendered once at construction) to instantiate in a test at all, so the
 * confirm-card glue was pulled out into its own module that only ever touches `document` through
 * `createElement` / element methods — no `innerHTML` parsing anywhere. That means this fake needs
 * no HTML parser either: it just has to behave like a real element for the handful of things
 * `confirm-panel.js` actually calls (`createElement`, `appendChild`, `className`, `textContent`,
 * `setAttribute`/`getAttribute`, `dataset`, `hidden`, `disabled`, `focus`, `remove`,
 * `replaceChildren`, `addEventListener`, and a tiny class-selector `querySelector`).
 *
 * M-9: every element also has a real (recording) `innerHTML` setter, even though the live glue
 * never uses it — that is exactly the point. `cardMarkup()`'s own escaping tests used to be the
 * only proof of safe HTML handling, but they exercised a string-building path nothing in the app
 * actually renders through. The property this fake needs to make testable is the live path's own:
 * that nothing `confirm-panel.js` does ever assigns `innerHTML` at all. Every write (were one ever
 * to happen) is appended to the owning `document`'s `innerHTMLWrites` array, so a test can assert
 * that array is empty after driving the panel with adversarial input — see
 * `test/confirm-panel.test.mjs`.
 */

export function createFakeDocument() {
  const doc = { innerHTMLWrites: [] }
  doc.createElement = (tagName) => createElement(tagName, doc)
  return doc
}

function createElement(tagName, doc) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    className: '',
    id: '',
    type: '',
    hidden: false,
    disabled: false,
    attributes: {},
    dataset: {},
    children: [],
    parent: null,
    _text: '',
    _listeners: {},
    _focused: false,

    setAttribute(name, value) {
      el.attributes[name] = String(value)
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null
    },
    removeAttribute(name) {
      delete el.attributes[name]
    },

    appendChild(child) {
      child.parent = el
      el.children.push(child)
      return child
    },
    append(...kids) {
      for (const k of kids) el.appendChild(k)
    },
    remove() {
      if (!el.parent) return
      const i = el.parent.children.indexOf(el)
      if (i !== -1) el.parent.children.splice(i, 1)
      el.parent = null
    },
    replaceChildren(...kids) {
      for (const c of el.children) c.parent = null
      el.children = []
      for (const k of kids) el.appendChild(k)
    },

    addEventListener(type, fn) {
      ;(el._listeners[type] ||= []).push(fn)
    },
    removeEventListener(type, fn) {
      if (!el._listeners[type]) return
      el._listeners[type] = el._listeners[type].filter((f) => f !== fn)
    },
    /** Test-only: fires every handler registered for `type`, like a real click would. */
    dispatch(type) {
      for (const fn of el._listeners[type] || []) fn()
    },

    focus() {
      el._focused = true
    },

    /** Enough of `querySelector` for a single `.class-name` lookup, depth-first. */
    querySelector(selector) {
      return findByClass(el, selector.replace(/^\./, ''))
    },

    get textContent() {
      if (el.children.length === 0) return el._text
      return el.children.map((c) => (typeof c.textContent === 'string' ? c.textContent : '')).join('')
    },
    set textContent(v) {
      el._text = String(v)
      el.children = []
    },

    get innerHTML() {
      return el._innerHTML || ''
    },
    /** Recorded on the owning document (M-9) — a real setter, so a stray write is caught, not silently a no-op. */
    set innerHTML(v) {
      el._innerHTML = String(v)
      if (doc) doc.innerHTMLWrites.push({ tagName: el.tagName, value: String(v) })
    },
  }
  return el
}

function findByClass(root, cls) {
  for (const child of root.children) {
    if (String(child.className).split(/\s+/).includes(cls)) return child
    const found = findByClass(child, cls)
    if (found) return found
  }
  return null
}
