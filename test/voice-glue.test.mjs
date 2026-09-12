import test from 'node:test'
import assert from 'node:assert/strict'

import { createVoice } from '../src/game/voice.js'

/**
 * createVoice's browser glue (WebSocket, AudioContext, AudioWorklet, getUserMedia) has no real
 * browser to run in under `node --test`, so these tests install minimal fakes on the globals it
 * reads and drive them by hand — firing onopen/onmessage/onclose, resolving or leaving pending the
 * promises a real browser would eventually settle, and asserting on what the glue did in response.
 * Each test installs its own fakes and restores the real globals in a `finally`, so tests never leak
 * into each other.
 */

class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = FakeSocket.OPEN
    this.sent = []
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    FakeSocket.instances.push(this)
  }
  send(data) {
    this.sent.push(data)
  }
  close() {
    this.readyState = FakeSocket.CLOSED
  }
}
FakeSocket.CONNECTING = 0
FakeSocket.OPEN = 1
FakeSocket.CLOSING = 2
FakeSocket.CLOSED = 3
FakeSocket.instances = []

const makeStream = () => {
  // `onended` fires only when the device goes away on its own (sleep, unplugged) — never on stop().
  const track = { stopped: false, onended: null, stop() { track.stopped = true } }
  return { getTracks: () => [track], track }
}

/** `moduleGate` and `resume()`'s promise are both mutable after creation, so a test can hold either open. */
const makeAudioContext = (startRunning) => {
  let resumeResolve = () => {}
  const resumePromise = new Promise((resolve) => {
    resumeResolve = resolve
  })
  const ctx = {
    state: startRunning ? 'running' : 'suspended',
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    moduleGate: Promise.resolve(),
    resume() {
      return resumePromise
    },
    allow() {
      // Simulates the autoplay gesture landing: resume() would now settle for real.
      ctx.state = 'running'
      resumeResolve()
    },
    setState(next) {
      // The browser moving the context on its own (sleep, a device change), as a real one reports it.
      ctx.state = next
      ctx.onstatechange?.()
    },
    audioWorklet: {
      addModule() {
        return ctx.moduleGate
      },
    },
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    },
    createBuffer(_channels, length, rate) {
      return { copyToChannel() {}, duration: length / rate }
    },
    createBufferSource() {
      return { connect() {}, start() {}, stop() {}, onended: null }
    },
  }
  return ctx
}

// navigator and localStorage are Node built-ins defined as accessor (getter-only) properties on
// globalThis, so a plain `globalThis.navigator = …` throws; defineProperty replaces them outright,
// and restoring with defineProperty (rather than assignment) puts an accessor property back the same
// way, instead of leaving a plain data property with today's snapshot sitting over it.
const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installFakes({ ctxRunning = false } = {}) {
  const realDescriptors = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  }
  const real = {
    WebSocket: globalThis.WebSocket,
    AudioContext: globalThis.AudioContext,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }

  FakeSocket.instances = []
  globalThis.WebSocket = FakeSocket

  const ctx = makeAudioContext(ctxRunning)
  globalThis.AudioContext = function AudioContext() {
    return ctx
  }

  let workletNodeCount = 0
  const nodes = []
  globalThis.AudioWorkletNode = class FakeWorkletNode {
    constructor() {
      workletNodeCount++
      this.port = { onmessage: null, postMessage() {} }
      nodes.push(this)
    }
    connect() {}
    disconnect() {}
  }

  let getUserMediaCalls = 0
  const streams = []
  defineGlobal('navigator', {
    mediaDevices: {
      async getUserMedia() {
        getUserMediaCalls++
        const stream = makeStream()
        streams.push(stream)
        return stream
      },
    },
  })

  let pointerdownHandler = null
  globalThis.document = {
    addEventListener(event, handler) {
      if (event === 'pointerdown') pointerdownHandler = handler
    },
    removeEventListener() {},
  }

  const store = {}
  defineGlobal('localStorage', {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v)
    },
  })

  // voice.js calls the bare `setTimeout`/`clearTimeout` globals directly (the 250 ms audioReady
  // race, the reconnect backoff, the 300 ms delay before `played` is sent) — tracked here so a stray
  // timer left running past a test's assertions (a scheduled reconnect, say) can't fire into a later
  // test.
  const timers = new Set()
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = real.setTimeout(fn, ms, ...args)
    timers.add(id)
    return id
  }
  globalThis.clearTimeout = (id) => {
    timers.delete(id)
    real.clearTimeout(id)
  }

  return {
    ctx,
    get getUserMediaCalls() {
      return getUserMediaCalls
    },
    get workletNodeCount() {
      return workletNodeCount
    },
    nodes,
    streams,
    sockets: FakeSocket.instances,
    firePointerdown() {
      const handler = pointerdownHandler
      pointerdownHandler = null
      return handler?.()
    },
    hasPointerdownWaiting: () => pointerdownHandler !== null,
    restore() {
      for (const id of timers) real.clearTimeout(id)
      timers.clear()
      globalThis.WebSocket = real.WebSocket
      globalThis.AudioContext = real.AudioContext
      globalThis.AudioWorkletNode = real.AudioWorkletNode
      globalThis.document = real.document
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
      if (realDescriptors.navigator) Object.defineProperty(globalThis, 'navigator', realDescriptors.navigator)
      else delete globalThis.navigator
      if (realDescriptors.localStorage) Object.defineProperty(globalThis, 'localStorage', realDescriptors.localStorage)
      else delete globalThis.localStorage
    },
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('a resume() that never resolves surfaces needs-click, and the pointerdown wake clears it', async () => {
  const fakes = installFakes({ ctxRunning: false })
  try {
    const states = []
    const voice = createVoice({ url: 'ws://fake/voice', onState: (s, r) => states.push([s, r]) })
    voice.start()
    const sock = fakes.sockets[0]
    assert.ok(sock, 'connect() opened a socket')

    // resume() never settles on its own; audioReady must give up on its own 250 ms deadline rather
    // than hang onopen forever.
    await sock.onopen()

    assert.equal(states.at(-1)[0], 'needs-click')
    assert.ok(fakes.hasPointerdownWaiting(), 'a pointerdown listener was queued to retry')

    // The gesture the browser was waiting for lands.
    fakes.ctx.allow()
    fakes.firePointerdown()
    await tick()
    await tick()
    await tick()

    assert.equal(fakes.getUserMediaCalls, 1)
    assert.notEqual(states.at(-1)[0], 'needs-click')
  } finally {
    fakes.restore()
  }
})

test('two simultaneous wakes (pointerdown and a click on the orb) only ever open one capture graph', async () => {
  const fakes = installFakes({ ctxRunning: false })
  try {
    const voice = createVoice({ url: 'ws://fake/voice', onState: () => {} })
    voice.start()
    const sock = fakes.sockets[0]
    await sock.onopen() // needs-click: resume() stays pending past the 250 ms deadline

    fakes.ctx.allow()
    fakes.firePointerdown() // fire-and-forget, exactly like a real DOM listener
    await voice.orbClicked().catch(() => {}) // races the very same wake
    await tick()
    await tick()
    await tick()

    assert.equal(fakes.getUserMediaCalls, 1, 'getUserMedia was only asked once')
    assert.equal(fakes.workletNodeCount, 1, 'only one AudioWorkletNode was built')
  } finally {
    fakes.restore()
  }
})

test('muting while the worklet module is still loading builds no graph and stops the stream', async () => {
  const fakes = installFakes({ ctxRunning: true })
  let resolveModule
  fakes.ctx.moduleGate = new Promise((resolve) => {
    resolveModule = resolve
  })
  try {
    const voice = createVoice({ url: 'ws://fake/voice', onState: () => {} })
    voice.start()
    const sock = fakes.sockets[0]
    await sock.onopen() // ctx is already running: falls straight through to a fire-and-forget startMic()

    await tick() // let getUserMedia settle and startMic reach the addModule await

    voice.toggleMute() // muted mid-flight, before the worklet module resolves

    resolveModule()
    await tick()
    await tick()

    assert.equal(fakes.workletNodeCount, 0, 'no capture graph was built')
    assert.equal(fakes.streams.at(-1)?.track.stopped, true, 'the leftover stream was stopped')
  } finally {
    fakes.restore()
  }
})

test('the socket closing while the worklet module is still loading builds no graph and stops the stream', async () => {
  const fakes = installFakes({ ctxRunning: true })
  let resolveModule
  fakes.ctx.moduleGate = new Promise((resolve) => {
    resolveModule = resolve
  })
  try {
    const voice = createVoice({ url: 'ws://fake/voice', onState: () => {} })
    voice.start()
    const sock = fakes.sockets[0]
    await sock.onopen()

    await tick() // let getUserMedia settle and startMic reach the addModule await

    sock.onclose({ code: 1006 }) // an ordinary drop, not the 4001 "taken" case

    resolveModule()
    await tick()
    await tick()

    assert.equal(fakes.workletNodeCount, 0, 'no capture graph was built')
    assert.equal(fakes.streams.at(-1)?.track.stopped, true, 'the leftover stream was stopped')
  } finally {
    fakes.restore()
  }
})

test('a 4001 close reads as taken, survives a mute toggle with no socket, and orbClicked reconnects', async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    const states = []
    const voice = createVoice({ url: 'ws://fake/voice', onState: (s, r) => states.push([s, r]) })
    voice.start()
    const sock1 = fakes.sockets[0]

    sock1.onclose({ code: 4001 })
    assert.equal(states.at(-1)[0], 'taken')

    voice.toggleMute() // there is no socket at all right now
    assert.equal(states.at(-1)[0], 'taken', 'muting with no socket must not paper over "taken"')

    await voice.orbClicked()
    assert.equal(fakes.sockets.length, 2, 'orbClicked opened a fresh connection')
    assert.notEqual(fakes.sockets[1], sock1)
  } finally {
    fakes.restore()
  }
})

test("a stale socket's late close does not clobber the socket that replaced it", async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    const voice = createVoice({ url: 'ws://fake/voice', onState: () => {} })
    voice.start()
    const sock1 = fakes.sockets[0]

    sock1.onclose({ code: 4001 }) // taken: ws is now null
    await voice.orbClicked() // reconnects: a fresh socket replaces it
    const sock2 = fakes.sockets[1]
    assert.ok(sock2 && sock2 !== sock1)

    sock1.onclose({ code: 1006 }) // the old socket's close event arrives late

    voice.toggleMute() // exercises `ws`: only sends if the current socket is still open
    assert.deepEqual(sock2.sent.map((s) => JSON.parse(s).type), ['mute'])
    assert.equal(sock1.sent.length, 0, "the stale socket's late close must not have nulled ws")
  } finally {
    fakes.restore()
  }
})

/** Opens a socket on a running context and lets the mic graph finish building. */
async function connected(fakes, opts = {}) {
  const states = []
  const voice = createVoice({ url: 'ws://fake/voice', onState: (s, r) => states.push([s, r]), ...opts })
  voice.start()
  const sock = fakes.sockets[0]
  await sock.onopen()
  await tick()
  await tick()
  return { voice, sock, states }
}

test('a mic track that ends on its own (sleep, a device change) is restarted with a fresh capture', async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    await connected(fakes)
    assert.equal(fakes.getUserMediaCalls, 1)
    assert.equal(fakes.workletNodeCount, 1)

    fakes.streams[0].track.onended()
    await tick()
    await tick()

    assert.equal(fakes.getUserMediaCalls, 2, 'the mic was asked for again')
    assert.equal(fakes.workletNodeCount, 2, 'a new capture graph was built')
    assert.equal(fakes.streams[0].track.stopped, true, 'the dead stream was let go')
  } finally {
    fakes.restore()
  }
})

test('a mic that cannot be restarted shows "blocked"', async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    const { states } = await connected(fakes)
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error('no device')
    }
    fakes.streams[0].track.onended()
    await tick()
    await tick()
    assert.equal(states.at(-1)[0], 'blocked')
  } finally {
    fakes.restore()
  }
})

test('the audio context stopping while connected asks for a click, and clears once it runs again', async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    const { states } = await connected(fakes)
    assert.notEqual(states.at(-1)[0], 'needs-click')

    fakes.ctx.setState('suspended')
    assert.equal(states.at(-1)[0], 'needs-click')
    assert.ok(fakes.hasPointerdownWaiting(), 'a click anywhere will wake it')

    fakes.ctx.setState('running')
    assert.notEqual(states.at(-1)[0], 'needs-click')
  } finally {
    fakes.restore()
  }
})

test('a mic that goes quiet for too long (no audio at all, not even silence) is restarted', async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    await connected(fakes, { micWatchdogMs: 50 })
    assert.equal(fakes.getUserMediaCalls, 1)
    await tick(200)
    assert.ok(fakes.getUserMediaCalls >= 2, 'the mic was restarted')
    assert.equal(fakes.streams[0].track.stopped, true)
  } finally {
    fakes.restore()
  }
})

test('a mic that keeps delivering audio is left alone by the watchdog', async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    await connected(fakes, { micWatchdogMs: 50 })
    for (let i = 0; i < 10; i++) {
      fakes.nodes[0].port.onmessage?.({ data: new Float32Array(960) })
      await tick(20)
    }
    assert.equal(fakes.getUserMediaCalls, 1)
  } finally {
    fakes.restore()
  }
})

test('the watchdog never restarts a mic while the audio context is not running', async () => {
  const fakes = installFakes({ ctxRunning: true })
  try {
    await connected(fakes, { micWatchdogMs: 50 })
    fakes.ctx.setState('suspended') // no audio arrives while suspended; that is not a dead mic
    await tick(200)
    assert.equal(fakes.getUserMediaCalls, 1)
  } finally {
    fakes.restore()
  }
})
