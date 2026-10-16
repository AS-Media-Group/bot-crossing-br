import test from 'node:test'
import assert from 'node:assert/strict'

import { backoffMs, createDownsampler, createDucker, DUCK, frameDb, MIC_CONSTRAINTS, MIC_GAIN_DB, orbFor, pcm16ToFloat32 } from '../src/game/voice.js'

const tone = (n, rate) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate))

test('48 kHz in 20 ms chunks becomes exactly 16 kHz', () => {
  const down = createDownsampler(48000)
  let total = 0
  for (let c = 0; c < 50; c++) total += down(tone(960, 48000)).length
  assert.equal(total, 16000)
})

test('44.1 kHz becomes 16 kHz too, to within a sample', () => {
  const down = createDownsampler(44100)
  let total = 0
  for (let c = 0; c < 50; c++) total += down(tone(882, 44100)).length
  assert.ok(Math.abs(total - 16000) <= 1, `got ${total}`)
})

test('chunked and all-at-once give the same samples', () => {
  const input = tone(48000, 48000)
  const whole = createDownsampler(48000)(input)
  const down = createDownsampler(48000)
  const parts = []
  for (let o = 0; o < input.length; o += 1000) parts.push(...down(input.subarray(o, o + 1000)))
  assert.deepEqual(Int16Array.from(parts), whole)
})

test('levels are kept and clipping is clamped', () => {
  const [half] = createDownsampler(48000)(new Float32Array(3).fill(0.5))
  assert.equal(half, 16384)
  const clipped = createDownsampler(48000)(Float32Array.from([2, 2, 2, -2, -2, -2]))
  assert.deepEqual([...clipped], [32767, -32768])
})

// Wake during playback (16.10.26): Chrome's noise suppression and auto gain squashed "Hey Jarvis" to a
// 0.000 score while Jarvis spoke; echo cancelling alone kept it, about 20 dB quieter. So the mic is
// opened with echo cancelling only, and the window adds back a fixed gain with a soft limiter.
test('the mic is opened with echo cancelling only: no noise suppression, no auto gain', () => {
  assert.deepEqual(MIC_CONSTRAINTS, { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false })
  assert.ok(Object.isFrozen(MIC_CONSTRAINTS))
  assert.equal(MIC_GAIN_DB, 12)
})

const steady = (v, n = 3) => new Float32Array(n).fill(v)
const DB12 = 10 ** (12 / 20) // 3.981

test('below the limiter a gain is exact: +12 dB makes 0.01 of full scale about 0.0398', () => {
  const [quiet] = createDownsampler(48000, 16000, 12)(steady(0.01))
  assert.equal(quiet, Math.round(0.01 * DB12 * 32767))
  const [negative] = createDownsampler(48000, 16000, 12)(steady(-0.1))
  assert.equal(negative, Math.round(-0.1 * DB12 * 32767), 'still linear just under the -6 dBFS knee')
})

test('above the knee the soft limiter compresses loud speech instead of clipping it', () => {
  const out = [0.13, 0.2, 0.3, 0.5, 1].map((v) => createDownsampler(48000, 16000, 12)(steady(v))[0])
  for (let i = 1; i < out.length; i++) assert.ok(out[i] > out[i - 1], `louder in stays louder out: ${out}`)
  assert.ok(out[3] < 32767, `twice over full scale after the gain still lands below the clip point: ${out[3]}`)
  const [shout] = createDownsampler(48000, 16000, 12)(steady(-1))
  assert.ok(shout > -32768 && shout < -32000, `symmetric for negative samples: ${shout}`)
})

test('at unity gain, explicit or default, nothing changes: no limiter, the old hard clamp', () => {
  // 0.75 is above the knee, so the limiter would bend it (to 23955); unity must leave it straight.
  for (const down of [createDownsampler(48000, 16000, 0), createDownsampler(48000)]) {
    const [loud, clipped] = down(Float32Array.from([0.75, 0.75, 0.75, -2, -2, -2]))
    assert.equal(loud, Math.round(0.75 * 32767))
    assert.equal(clipped, -32768, 'out-of-range input is still clamped, not limited')
  }
})

// Wake during playback, part 2 (16.10.26): with echo cancelling only, the voice of someone talking over
// Jarvis reached the wake word at full strength, but what was left of Jarvis's voice under it still held
// the score under the cutoff. So while Jarvis plays, a voice well above the room's floor ducks him.
const DUCKED = 10 ** (-18 / 20) // 0.126

test('frameDb: one 20 ms frame as dBFS, with silence floored at -120', () => {
  assert.equal(Math.round(frameDb(new Int16Array(320).fill(3277)) * 10) / 10, -20)
  assert.equal(frameDb(new Int16Array(320)), -120)
  assert.equal(frameDb(new Int16Array(0)), -120)
})

test('the duck defaults are the measured ones', () => {
  assert.deepEqual(DUCK, { marginDb: 15, minThresholdDb: -36, maxThresholdDb: -20, depthDb: -18, onsetFrames: 2, holdMs: 1200, floorStartDb: -60, floorRiseDb: 0.05, ignoreBelowDb: -100 })
  assert.ok(Object.isFrozen(DUCK))
})

test('the floor falls at once to a quieter frame, creeps up slowly, and ignores digital silence', () => {
  const d = createDucker()
  assert.equal(d.floorDb, -60)
  d.observe(-48, 0, false)
  assert.equal(Math.round(d.floorDb * 100) / 100, -59.95, 'a louder frame lifts it only 0.05 dB')
  d.observe(-70, 20, false)
  assert.equal(d.floorDb, -70)
  d.observe(-120, 40, false)
  d.observe(-100, 60, false)
  assert.equal(d.floorDb, -70, 'zeros from a mic just reopened are not the room')
})

test('the threshold sits 15 dB over the floor, kept between -36 and -20 dBFS', () => {
  const at = (floor) => {
    const d = createDucker({ ...DUCK, floorStartDb: floor })
    return d.thresholdDb
  }
  assert.equal(at(-48), -33)
  // Jarvis's loudest echo-cancelled leftover frame measured -42.6 dBFS: 6 dB of margin under -36.
  assert.equal(at(-70), -36, 'a very quiet floor never lets echo leftovers duck him')
  assert.equal(at(-30), -20, 'a noisy room does not need a shout')
})

test('two loud frames in a row while Jarvis plays duck him; one is not enough', () => {
  const d = createDucker({ ...DUCK, floorStartDb: -48 })
  assert.equal(d.observe(-25, 0, true), 1, 'a single click or tap')
  assert.equal(d.observe(-46, 20, true), 1)
  assert.equal(d.observe(-25, 40, true), 1)
  assert.equal(d.observe(-25, 60, true), DUCKED)
})

test('the duck holds 1200 ms after the last loud frame, and a loud frame extends it', () => {
  const d = createDucker({ ...DUCK, floorStartDb: -48 })
  d.observe(-25, 0, true)
  assert.equal(d.observe(-25, 20, true), DUCKED)
  assert.equal(d.observe(-47, 600, true), DUCKED)
  assert.equal(d.observe(-25, 700, true), DUCKED, 'still talking')
  assert.equal(d.observe(-47, 1899, true), DUCKED)
  assert.equal(d.observe(-47, 1900, true), 1, '1200 ms after the last loud frame')
})

test('with Jarvis silent nothing is ducked, and a duck in progress clears', () => {
  const d = createDucker({ ...DUCK, floorStartDb: -48 })
  assert.equal(d.observe(-25, 0, false), 1)
  assert.equal(d.observe(-25, 20, false), 1)
  d.observe(-25, 40, true)
  assert.equal(d.observe(-25, 60, true), DUCKED)
  assert.equal(d.observe(-25, 80, false), 1, 'his audio ended')
  assert.equal(d.observe(-47, 100, true), 1, 'the next sentence starts at full volume while the room is quiet')
})

test('reset clears a duck but keeps what it learned about the room', () => {
  const d = createDucker({ ...DUCK, floorStartDb: -48 })
  d.observe(-25, 0, true)
  d.observe(-25, 20, true)
  d.reset()
  assert.equal(d.observe(-47, 40, true), 1)
  assert.ok(d.floorDb < -47, `floor kept: ${d.floorDb}`)
})

test('Jarvis\'s audio converts back to the range the speakers take', () => {
  assert.deepEqual([...pcm16ToFloat32(Int16Array.from([-32768, 0, 16384]))], [-1, 0, 0.5])
})

test('reconnecting backs off, and stops growing at 5 s', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(backoffMs), [500, 1000, 2000, 5000, 5000])
})

test('every state has an orb and a label', () => {
  const modes = new Set(['waiting', 'listening', 'thinking', 'speaking', 'followup', 'muted', 'off'])
  for (const s of ['waiting', 'listening', 'thinking', 'speaking', 'followup', 'muted', 'unavailable', 'taken', 'disconnected', 'needs-click', 'blocked', 'nonsense']) {
    const { mode, label } = orbFor(s)
    assert.ok(modes.has(mode), `${s} → ${mode}`)
    assert.ok(label.length > 0, s)
  }
  assert.equal(orbFor('unavailable', 'restarting').label, 'Voice restarting…')
  assert.equal(orbFor('unavailable', 'voice is off').label, 'Voice unavailable')
  assert.equal(orbFor('waiting', 'could not speak').label, 'Couldn’t speak that answer')
  assert.match(orbFor('taken').label, /another window/)
})
