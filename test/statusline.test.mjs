/**
 * The status-line wrapper: the one place a plan-limit number can come from.
 *
 * Claude Code hands its status-line command a JSON blob that includes `rate_limits` for Pro and
 * Max subscribers. This wrapper saves those numbers where the colony can read them and then runs
 * whatever status line the user already had, unchanged.
 *
 * Which makes its first duty "do no harm": the user's status line must keep working — same input,
 * same output, same exit code — whether or not the save succeeds, because a broken status line is
 * a broken prompt on every line the user types.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOL = fileURLToPath(new URL('../tools/statusline-limits.mjs', import.meta.url))
const scratch = () => fsp.mkdtemp(path.join(os.tmpdir(), 'bc-statusline-'))

const INPUT = JSON.stringify({
  model: { display_name: 'Opus 5' },
  context_window: { used_percentage: 8 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
})

/** Runs the wrapper the way Claude Code runs a status line: JSON on stdin, one line on stdout. */
function run(args, { input = INPUT, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('saves the limits and prints what the wrapped status line printed', async () => {
  const dir = await scratch()
  const file = path.join(dir, 'limits.json')

  const { code, stdout } = await run(['--out', file, '--', process.execPath, '-e', 'process.stdout.write("[Opus 5] 8% context")'])

  assert.equal(code, 0)
  assert.equal(stdout, '[Opus 5] 8% context', 'the user sees their own status line, not ours')
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'))
  assert.equal(saved.rate_limits.five_hour.used_percentage, 23.5)
  assert.equal(saved.rate_limits.seven_day.used_percentage, 41.2)
  assert.ok(saved.savedAt > 0, 'the age of the numbers is the difference between fresh and history')
})

test('hands the wrapped status line the same JSON it was given', async () => {
  const dir = await scratch()
  // Echoes back what it read on stdin, so the test can compare it byte for byte.
  const echo = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s))'

  const { stdout } = await run(['--out', path.join(dir, 'limits.json'), '--', process.execPath, '-e', echo])

  assert.equal(stdout, INPUT)
})

test('a status line with nothing to save still runs', async () => {
  const dir = await scratch()
  const file = path.join(dir, 'limits.json')

  const { code, stdout } = await run(['--out', file, '--', process.execPath, '-e', 'process.stdout.write("ok")'], {
    input: JSON.stringify({ model: { display_name: 'Opus 5' } }),
  })

  assert.equal(code, 0)
  assert.equal(stdout, 'ok')
  // No rate_limits in the input (a free plan, or the first turn of a session): the last known
  // numbers must be left alone rather than overwritten with nothing.
  await assert.rejects(fsp.readFile(file, 'utf8'), 'nothing to save means no file written')
})

test('an unwritable save location does not break the user’s status line', async () => {
  const { code, stdout } = await run([
    '--out',
    path.join('/', 'definitely', 'not', 'writable', 'limits.json'),
    '--',
    process.execPath,
    '-e',
    'process.stdout.write("still here")',
  ])

  assert.equal(code, 0)
  assert.equal(stdout, 'still here')
})

test('passes on the exit code of the wrapped status line', async () => {
  const dir = await scratch()
  const { code } = await run(['--out', path.join(dir, 'limits.json'), '--', process.execPath, '-e', 'process.exit(3)'])
  assert.equal(code, 3)
})

test('with no status line to wrap it saves and says nothing', async () => {
  const dir = await scratch()
  const file = path.join(dir, 'limits.json')

  const { code, stdout } = await run(['--out', file])

  assert.equal(code, 0)
  assert.equal(stdout, '')
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).rate_limits.five_hour.used_percentage, 23.5)
})
