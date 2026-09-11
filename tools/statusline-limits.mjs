#!/usr/bin/env node
/**
 * Save the plan limits Claude Code hands a status line, then run the status line you already had.
 *
 * Claude Code passes its status-line command a JSON blob on stdin which, for Claude.ai Pro and Max
 * subscribers, includes `rate_limits` — the 5-hour and weekly windows as a used percentage and a
 * reset time. That is the only supported way for another program on this machine to learn them, so
 * the colony reads them from a file this wrapper writes. No token is read, no API is called.
 *
 * Usage, in `~/.claude/settings.json`:
 *
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node /path/to/tools/statusline-limits.mjs --out ~/…/limits.json -- node /path/to/your-statusline.js"
 *   }
 *
 * Everything after `--` is the status line you had before, run with the same stdin and its output
 * passed straight through. Drop that part and this prints nothing, which is a valid status line.
 *
 * The prompt wins every argument: a save that cannot be made is skipped silently, because a
 * status-line command that fails is a broken prompt on every line the user types. For the same
 * reason input without `rate_limits` — a free plan, or the first turn before any reply — leaves
 * the previous numbers alone instead of overwriting them with nothing.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function parseArgs(argv) {
  const split = argv.indexOf('--')
  const mine = split === -1 ? argv : argv.slice(0, split)
  const wrapped = split === -1 ? [] : argv.slice(split + 1)
  let out = ''
  for (let i = 0; i < mine.length; i++) {
    if ((mine[i] === '--out' || mine[i] === '-o') && mine[i + 1]) out = mine[++i]
  }
  return { out, wrapped }
}

/** `~` is not expanded by the shell Claude Code uses for this, so expand it here. */
const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

const readStdin = () =>
  new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => (text += d))
    process.stdin.on('end', () => resolve(text))
    process.stdin.on('error', () => resolve(text))
  })

/** Written whole, then moved into place, so a reader never sees half a file. */
async function save(file, limits) {
  const target = expand(file)
  const tmp = `${target}.${process.pid}.tmp`
  const body = JSON.stringify({ savedAt: Date.now(), rate_limits: limits })
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(tmp, body)
  await fsp.rename(tmp, target)
}

function runWrapped(argv, input) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'inherit', 'inherit'] })
    // A status line that ignores its stdin closes the pipe early; that is not an error here.
    child.stdin.on('error', () => {})
    child.on('error', () => resolve(0))
    child.on('close', (code) => resolve(code ?? 0))
    child.stdin.end(input)
  })
}

const { out, wrapped } = parseArgs(process.argv.slice(2))
const input = await readStdin()

if (out) {
  try {
    const limits = JSON.parse(input)?.rate_limits
    if (limits && typeof limits === 'object') await save(out, limits)
  } catch {
    // Unreadable input or an unwritable path: the status line below still runs.
  }
}

process.exit(wrapped.length ? await runWrapped(wrapped, input) : 0)
