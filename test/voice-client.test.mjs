import test from 'node:test'
import assert from 'node:assert/strict'

import { backoffMs, createDownsampler, orbFor, pcm16ToFloat32 } from '../src/game/voice.js'

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
