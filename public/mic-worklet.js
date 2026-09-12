/**
 * The microphone, 20 ms at a time. An AudioWorklet runs on the audio thread, so the page gets steady
 * chunks even while the colony is busy drawing. It writes nothing to its output: nothing is played
 * back, but it has to be connected to the speakers for the browser to run it at all.
 */
class JarvisMic extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.size = options?.processorOptions?.chunk || 960
    this.buf = new Float32Array(this.size)
    this.n = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buf[this.n++] = channel[i]
        if (this.n === this.size) {
          this.port.postMessage(this.buf.slice(0))
          this.n = 0
        }
      }
    }
    return true
  }
}

registerProcessor('jarvis-mic', JarvisMic)
