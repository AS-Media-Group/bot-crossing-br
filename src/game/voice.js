/**
 * Jarvis's ears and voice in the colony window.
 *
 * The microphone goes to Jarvis — a separate, private service on this machine — and Jarvis's voice
 * comes back and plays. Nothing here understands speech: this file moves audio and reports state, so
 * the colony knows nothing about models, words or the machine it runs on.
 *
 * The pure helpers at the top are what the tests cover; createVoice below them is browser glue.
 */
export const MIC_RATE = 16000
const MUTE_KEY = 'bc.jarvis.muted'
const ACTIVE = new Set(['listening', 'thinking', 'speaking', 'followup'])

/**
 * Microphone rate (48 kHz, or 44.1 kHz on some Macs) down to the 16 kHz speech models want: each
 * output sample is the average of the input samples it covers — a box filter, which is plenty for
 * speech. Stateful, because a 44.1 kHz chunk does not divide evenly and the leftover must carry over.
 */
export function createDownsampler(inRate, outRate = MIC_RATE) {
  const step = inRate / outRate
  let carry = new Float32Array(0)
  let pos = 0 // where the next output sample starts, in input samples from the start of `carry`
  return (chunk) => {
    const input = new Float32Array(carry.length + chunk.length)
    input.set(carry)
    input.set(chunk, carry.length)
    const out = []
    while (pos + step <= input.length) {
      const a = Math.floor(pos)
      const b = Math.floor(pos + step)
      let sum = 0
      for (let j = a; j < b; j++) sum += input[j]
      const v = b > a ? sum / (b - a) : input[a]
      out.push(Math.max(-32768, Math.min(32767, Math.round(v * 32767))))
      pos += step
    }
    const used = Math.floor(pos)
    carry = input.slice(used)
    pos -= used
    return Int16Array.from(out)
  }
}

export function pcm16ToFloat32(int16) {
  const out = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768
  return out
}

export const backoffMs = (attempt) => [500, 1000, 2000, 5000][Math.min(Math.max(0, attempt), 3)]

const LABELS = {
  waiting: ['waiting', 'Say “Hey Jarvis”'],
  listening: ['listening', 'Listening…'],
  thinking: ['thinking', 'Thinking…'],
  speaking: ['speaking', 'Speaking — Esc to stop'],
  followup: ['followup', 'Go on — I’m listening'],
  muted: ['muted', 'Muted — press M'],
  taken: ['off', 'Listening in another window — click to take over'],
  disconnected: ['off', 'Reconnecting to Jarvis…'],
  'needs-click': ['off', 'Click to wake me'],
  blocked: ['off', 'Mic blocked — allow it in Chrome, then click'],
}
const UNAVAILABLE = { starting: 'Voice starting…', restarting: 'Voice restarting…', 'voice is off': 'Voice unavailable' }

export function orbFor(state, reason) {
  if (state === 'unavailable') return { mode: 'off', label: UNAVAILABLE[reason] || 'Voice unavailable' }
  if (state === 'waiting' && reason === 'could not speak') return { mode: 'waiting', label: 'Couldn’t speak that answer' }
  const hit = LABELS[state]
  return hit ? { mode: hit[0], label: hit[1] } : { mode: 'off', label: 'Voice unavailable' }
}

const readMuted = () => {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}
const writeMuted = (on) => {
  try {
    localStorage.setItem(MUTE_KEY, on ? '1' : '0')
  } catch {
    // Storage blocked: mute still works for this window, it just is not remembered.
  }
}

export function createVoice({ url, onState = () => {}, onHeard = () => {}, onAnswer = () => {}, onReconnect = () => {} }) {
  let ws = null
  let ctx = null
  let workletLoaded = false
  let mic = null // { stream, source, node }
  let starting = null // startMic is single-flight: the in-flight promise, or null
  let waking = null // wakeAudio is single-flight too, for the same reason
  let pointerWaiting = false // at most one pointerdown listener queued at a time
  let muted = readMuted()
  let attempt = 0
  let retry = null
  let server = { state: 'disconnected' } // the last state Jarvis sent (or the connection's own)
  let overlay = null // a local problem Jarvis cannot see: 'needs-click' or 'blocked'
  let taken = false // set only by a 4001 close; kept apart from `server` so muting never masks it
  let state = 'disconnected'
  let incoming = null // { id, rate }: the say whose audio is arriving
  let sources = []
  let playhead = 0
  let playedTimers = []

  // `taken` wins over everything else — a window that lost the mic stays visibly "taken" no matter
  // what Jarvis or a local mute does next, until orbClicked asks to reconnect.
  const show = () => {
    state = taken ? 'taken' : overlay ?? server.state
    onState(state, taken || overlay ? undefined : server.reason)
  }
  const setServer = (s, reason) => {
    server = { state: s, reason }
    show()
  }
  const send = (msg) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /**
   * Chrome leaves `resume()` on a context the autoplay policy refused to start permanently pending —
   * it never rejects (seen on every fresh window open). Racing it against a timeout is the only way
   * to find out "not yet" without hanging every reconnect's onopen forever.
   */
  async function audioReady() {
    ctx ??= new AudioContext()
    if (ctx.state === 'running') return true
    const resumed = ctx.resume().catch(() => {})
    await Promise.race([resumed, new Promise((r) => setTimeout(r, 250))])
    return ctx.state === 'running'
  }

  function startMic() {
    if (starting) return starting
    starting = doStartMic().finally(() => {
      starting = null
    })
    return starting
  }

  /**
   * Single-flight and re-checked after every await: two callers racing to wake the mic (the
   * pointerdown listener and a click on the orb, say) must not open two capture graphs, and muting
   * or losing the socket mid-setup must not leave an orphan graph or a leaked stream.
   */
  async function doStartMic() {
    if (mic || muted || !ws) return
    const sock = ws // the start is only still wanted while this exact socket is the live one
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      overlay = 'blocked'
      return show()
    }
    if (mic || muted || ws !== sock) {
      stream.getTracks().forEach((t) => t.stop()) // muted, closed, or beaten to it while the prompt was up
      return
    }
    try {
      if (!workletLoaded) {
        await ctx.audioWorklet.addModule('/mic-worklet.js')
        workletLoaded = true
      }
      if (mic || muted || ws !== sock) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, 'jarvis-mic', { processorOptions: { chunk: Math.round(ctx.sampleRate / 50) } })
      const down = createDownsampler(ctx.sampleRate)
      node.port.onmessage = (e) => {
        if (ws?.readyState === WebSocket.OPEN && !muted) ws.send(down(e.data).buffer)
      }
      source.connect(node)
      node.connect(ctx.destination) // silent: the worklet only runs while it reaches the speakers
      mic = { stream, source, node }
      if (overlay === 'blocked') overlay = null
      show()
    } catch {
      stream.getTracks().forEach((t) => t.stop()) // addModule rejected, or the graph failed to build
    }
  }

  function stopMic() {
    if (!mic) return
    mic.node.port.postMessage({ stop: true })
    mic.stream.getTracks().forEach((t) => t.stop()) // Chrome's mic indicator goes out
    mic.node.port.onmessage = null
    mic.source.disconnect()
    mic.node.disconnect()
    mic = null
  }

  function play(buf) {
    if (!incoming || !ctx || ctx.state !== 'running') return
    const samples = pcm16ToFloat32(new Int16Array(buf))
    if (!samples.length) return
    const b = ctx.createBuffer(1, samples.length, incoming.rate)
    b.copyToChannel(samples, 0)
    const src = ctx.createBufferSource()
    src.buffer = b
    src.connect(ctx.destination)
    const at = Math.max(ctx.currentTime + 0.03, playhead)
    src.start(at)
    playhead = at + b.duration
    sources.push(src)
    src.onended = () => {
      sources = sources.filter((s) => s !== src)
    }
  }

  /**
   * `played` means the speaker has actually gone quiet — only then may Jarvis listen again. Plus
   * 300 ms: the browser's echo cancellation does not fully remove Jarvis's own voice from the mic,
   * so the room's echo gets time to die away first.
   */
  function finished(id) {
    const left = ctx ? Math.max(0, playhead - ctx.currentTime) : 0
    playedTimers.push(setTimeout(() => send({ type: 'played', id }), left * 1000 + 300))
    incoming = null
  }

  function stopPlayback() {
    for (const s of sources) {
      try {
        s.stop()
      } catch {
        // Already finished.
      }
    }
    sources = []
    playhead = 0
    incoming = null
    playedTimers.forEach(clearTimeout)
    playedTimers = []
  }

  function onMessage(e) {
    if (typeof e.data !== 'string') return play(e.data)
    let msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (msg.type === 'state') setServer(msg.state, msg.reason)
    else if (msg.type === 'heard') onHeard(String(msg.text ?? ''))
    else if (msg.type === 'answer') onAnswer(msg.reply)
    else if (msg.type === 'audio-start') incoming = { id: msg.id, rate: Number(msg.sampleRate) || 24000 }
    else if (msg.type === 'audio-end') finished(msg.id)
    else if (msg.type === 'hush') stopPlayback()
  }

  function wakeAudio() {
    if (waking) return waking
    waking = doWakeAudio().finally(() => {
      waking = null
    })
    return waking
  }

  // Clears the 'needs-click' overlay only once the context is actually running — a second wake
  // racing this one (a queued pointerdown plus a click on the orb) shares this same promise instead
  // of opening its own capture graph.
  async function doWakeAudio() {
    if (!(await audioReady())) return
    if (overlay === 'needs-click') overlay = null
    show()
    await startMic()
  }

  function addPointerWake() {
    if (pointerWaiting) return // one queued listener is enough; don't stack another
    pointerWaiting = true
    document.addEventListener(
      'pointerdown',
      () => {
        pointerWaiting = false
        wakeAudio().catch(() => {})
      },
      { once: true },
    )
  }

  function connect() {
    clearTimeout(retry)
    const sock = new WebSocket(url) // bound to its own handlers below, so a stale socket can never touch `ws`
    ws = sock
    sock.binaryType = 'arraybuffer'
    sock.onopen = async () => {
      if (sock !== ws) return
      attempt = 0
      send({ type: 'hello', v: 1 })
      if (muted) send({ type: 'mute', on: true })
      onReconnect()
      if (!(await audioReady())) {
        if (sock !== ws) return
        overlay = 'needs-click'
        show()
        addPointerWake()
        return
      }
      startMic().catch(() => {})
    }
    sock.onmessage = (e) => {
      if (sock !== ws) return
      onMessage(e)
    }
    sock.onclose = (e) => {
      if (sock !== ws) return // a superseded socket closing late must not null the socket that replaced it
      ws = null
      stopMic()
      stopPlayback()
      if (e.code === 4001) {
        taken = true // another window has the mic: never grab it back unasked
        return show()
      }
      setServer('disconnected')
      retry = setTimeout(connect, backoffMs(attempt++))
    }
  }

  function stop() {
    send({ type: 'stop' })
    stopPlayback()
  }

  return {
    start() {
      if (!ws) connect()
    },
    muted: () => muted,
    isActive: () => ACTIVE.has(state),
    toggleMute() {
      muted = !muted
      writeMuted(muted)
      if (muted) {
        stopMic()
        stopPlayback()
      }
      // The mute preference is always recorded. But the server-side 'muted' state is only ours to set
      // while there is a socket to back it up — with none (disconnected, or another window has the
      // mic), setting it here would paper over 'taken' or 'disconnected'; just redraw what is true.
      if (ws?.readyState === WebSocket.OPEN) {
        send({ type: 'mute', on: muted })
        if (muted) setServer('muted')
        else startMic().catch(() => {}) // Jarvis answers with the state to show
      } else {
        show()
      }
    },
    stop,
    async orbClicked() {
      if (taken) {
        taken = false
        setServer('disconnected')
        return connect() // Jarvis hands the mic to the newest window: this one
      }
      if (overlay) return wakeAudio().catch(() => {})
      if (state === 'waiting') send({ type: 'listen' })
      else if (ACTIVE.has(state)) stop()
    },
  }
}
