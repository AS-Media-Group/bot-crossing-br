/**
 * The harness seam: what an adapter is allowed to hand back, and the two things the colony has
 * historically got wrong about a thread — which repo it belongs to, and whether it is working.
 *
 * Fixture-driven. Nothing here reads a real harness, so it says the same thing on any machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { HARNESSES } from '../server/harnesses/index.mjs'
import codex from '../server/harnesses/codex.mjs'
import claudeCode from '../server/harnesses/claude-code.mjs'
import { readHead, readRecordsUntil, readTail, findExecutable } from '../server/lib/fsutil.mjs'
import { schemeOf, openInTerminal } from '../server/lib/xdg.mjs'

// ── the contract ──────────────────────────────────────────────────────────────

test('every registered harness implements the interface, and none of them can write', () => {
  for (const h of HARNESSES) {
    assert.match(h.id, /^[a-z0-9-]+$/, `${h.id} is not a kebab-case id`)
    assert.equal(typeof h.name, 'string')
    for (const fn of ['detect', 'scanThreads', 'openThread', 'newSession']) {
      assert.equal(typeof h[fn], 'function', `${h.id} is missing ${fn}()`)
    }
    // The one rule the project will not bend on. An adapter that grows a write is a bug.
    assert.equal(h.setArchived, undefined, `${h.id} must not write to its harness`)
  }
})

test('harness ids are unique, and so are the id prefixes they hand out', () => {
  const ids = HARNESSES.map((h) => h.id)
  assert.equal(new Set(ids).size, ids.length)
})

// ── ids are prefixed, and refs from the page are not trusted ──────────────────

test('a session id that merely stringifies to a UUID is refused', async () => {
  // `RegExp.test` coerces, so an array holding a valid id passes the pattern and then travels on
  // as an array. Both adapters check the type first.
  const uuid = '2df3987c-02d3-405e-b8f5-da30e3835213'
  assert.equal((await claudeCode.openThread({ cliSessionId: [uuid] })).ok, false)
  assert.equal((await claudeCode.openThread({ desktopSessionId: { toString: () => `local_${uuid}` } })).ok, false)
  assert.equal(codex.openThread({ sessionId: [uuid] }).ok, false)
  assert.equal(codex.openThread({}).ok, false)
  assert.equal(codex.openThread(null).ok, false)
})

test('codex opens through the registered scheme and prefixes its ids', () => {
  const id = '019cc762-45a2-7112-89cd-cd345c17e834'
  const opened = codex.openThread({ sessionId: id })
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'codex')
  assert.equal(opened.url, `codex://threads/${id}`)
})

// ── a Codex install, faked on disk ────────────────────────────────────────────

const line = (type, payload, timestamp = '2026-09-07T12:00:00.000Z') => JSON.stringify({ timestamp, type, payload })

/** One id for every fixture, so a test can name it before the transcript exists. */
const SESSION_ID = '019cc762-45a2-7112-89cd-cd345c17e834'

async function fakeCodex(records) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-fixture-'))
  const day = path.join(home, 'sessions', '2026', '09', '07')
  await fsp.mkdir(day, { recursive: true })
  await fsp.writeFile(path.join(day, `rollout-2026-09-07T12-00-00-${SESSION_ID}.jsonl`), records.join('\n') + '\n')
  return home
}

async function scanWith(home) {
  process.env.CODEX_HOME = home
  const mod = await import(`../server/harnesses/codex.mjs?${home}`)
  return mod.default
}

test('a CLI-only Codex session is found with no database at all', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo', git: { branch: 'main' } }),
    line('turn_context', { model: 'gpt-5.3-codex', effort: 'high' }),
    line('response_item', { type: 'message', role: 'user', content: [{ text: 'ship the thing' }] }),
    line('event_msg', { type: 'task_complete' }),
  ])
  const h = await scanWith(home)
  assert.equal(await h.detect(), true)
  const [t] = await h.scanThreads()
  assert.equal(t.id, `codex:${SESSION_ID}`, 'ids are prefixed')
  assert.equal(t.project, 'demo')
  assert.equal(t.model, 'gpt-5.3-codex')
  assert.equal(t.effort, 'high')
  assert.equal(t.gitBranch, 'main')
  assert.equal(t.preview, 'ship the thing')
  assert.ok(t.sizeBytes > 0, 'sizeBytes is transcript bytes, not a token count')
  assert.equal(t.running, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('an interrupted turn is not an error — escape must not redden an astronaut', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('event_msg', { type: 'task_started' }),
    line('event_msg', { type: 'turn_aborted' }),
  ])
  const h = await scanWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.hasError, false)
  assert.equal(t.running, false, 'an aborted turn is not still running')
  await fsp.rm(home, { recursive: true, force: true })
})

test('a task started long ago is not still running', async () => {
  const home = await fakeCodex([
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('event_msg', { type: 'task_started' }),
  ])
  const day = path.join(home, 'sessions', '2026', '09', '07')
  const [file] = await fsp.readdir(day)
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000)
  await fsp.utimes(path.join(day, file), old, old)
  const h = await scanWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false, 'Codex writes nothing when killed, so the window has to bound it')
  await fsp.rm(home, { recursive: true, force: true })
})

test('malformed records are skipped rather than throwing the scan away', async () => {
  const home = await fakeCodex([
    'not json at all',
    '{"half": ',
    line('session_meta', { id: SESSION_ID, cwd: '/tmp/demo' }),
    line('response_item', { type: 'message', role: 'user', content: 'hello' }),
  ])
  const h = await scanWith(home)
  const threads = await h.scanThreads()
  assert.equal(threads.length, 1)
  assert.equal(threads[0].preview, 'hello')
  await fsp.rm(home, { recursive: true, force: true })
})

test('an absent Codex is simply not detected', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-empty-'))
  const h = await scanWith(home)
  assert.equal(await h.detect(), false)
  assert.deepEqual(await h.scanThreads(), [])
  await fsp.rm(home, { recursive: true, force: true })
})

// ── shared helpers ────────────────────────────────────────────────────────────

test('readTail drops the partial line it lands in the middle of', async () => {
  const f = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'tail-')), 'x.jsonl')
  await fsp.writeFile(f, 'first line\nsecond line\nthird line\n')
  assert.equal(await readTail(f, 15), 'third line\n')
  assert.equal(await readTail(f, 1000), 'first line\nsecond line\nthird line\n')
})

test('readRecordsUntil reassembles a record bigger than any one read, and stops where asked', async () => {
  const f = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'records-')), 'x.jsonl')
  // 150k two-byte characters: 300KB of UTF-8 behind an odd-length prefix, so characters straddle reads.
  const huge = { type: 'queue-operation', content: 'é'.repeat(150 * 1024) }
  const lines = [huge, { type: 'user', cwd: '/tmp/demo' }, { type: 'after' }]
  await fsp.writeFile(f, lines.map((r) => JSON.stringify(r)).join('\n') + '\n')
  // What the head reader makes of it: one line longer than the window is no lines at all.
  assert.equal(await readHead(f, 192 * 1024), '')
  const records = await readRecordsUntil(f, { maxBytes: 2 * 1024 * 1024, until: (r) => Boolean(r.cwd) })
  assert.equal(records.length, 2, 'stops at the first record that satisfies until()')
  assert.equal(records[0].content, huge.content, 'a character split across two reads comes back intact')
  assert.equal(records[1].cwd, '/tmp/demo')
})

test('readRecordsUntil gives up at its byte budget rather than reading the whole file', async () => {
  const f = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'records-')), 'x.jsonl')
  const lines = [{ content: 'x'.repeat(300 * 1024) }, { cwd: '/tmp/demo' }]
  await fsp.writeFile(f, lines.map((r) => JSON.stringify(r)).join('\n') + '\n')
  assert.deepEqual(await readRecordsUntil(f, { maxBytes: 100 * 1024, until: (r) => Boolean(r.cwd) }), [])
})

test('readRecordsUntil reads a last line that has no newline after it', async () => {
  const f = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'records-')), 'x.jsonl')
  await fsp.writeFile(f, JSON.stringify({ a: 1 }) + '\n' + JSON.stringify({ cwd: '/x' }))
  const records = await readRecordsUntil(f, { maxBytes: 1024, until: (r) => Boolean(r.cwd) })
  assert.deepEqual(records, [{ a: 1 }, { cwd: '/x' }])
})

test('findExecutable refuses junk, and refuses a directory that sits on PATH', async () => {
  assert.equal(await findExecutable(''), null)
  assert.equal(await findExecutable(null), null)
  assert.equal(await findExecutable('.'), null)
  assert.equal(await findExecutable('definitely-not-a-real-binary-xyz'), null)
})

test('openInTerminal refuses anything not already resolved to absolute paths', async () => {
  assert.equal((await openInTerminal(['ls'], '/tmp')).ok, false, 'relative argv[0]')
  assert.equal((await openInTerminal(['/bin/ls'], 'relative')).ok, false, 'relative cwd')
  assert.equal((await openInTerminal([], '/tmp')).ok, false, 'empty argv')
  assert.equal((await openInTerminal(['/bin/ls', 123], '/tmp')).ok, false, 'non-string argument')
})

// ── Cursor, faked on disk ─────────────────────────────────────────────────────

async function fakeCursor(dirName, records) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-fixture-'))
  const dir = path.join(home, dirName, 'agent-transcripts', SESSION_ID)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return home
}

async function cursorWith(home) {
  process.env.BOT_CROSSING_CURSOR_PROJECTS = home
  const mod = await import(`../server/harnesses/cursor.mjs?${home}`)
  return mod.default
}

const askedFor = (text) => ({ role: 'user', message: { content: [{ type: 'text', text }] } })

test('a Cursor transcript yields a thread with the typed query as its title', async () => {
  const home = await fakeCursor('tmp', [
    askedFor('<timestamp>Tuesday, Sep 8, 2026, 4:08 PM (UTC-7)</timestamp>\n<user_query>\nwhat project is this?\n</user_query>'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'It is…' }] } },
    { type: 'turn_ended', status: 'success' },
  ])
  const h = await cursorWith(home)
  assert.equal(await h.detect(), true)
  const [t] = await h.scanThreads()
  assert.equal(t.id, `cursor:${SESSION_ID}`)
  // Cursor's own wrapper tags are scaffolding, not something a person typed.
  assert.equal(t.title, 'what project is this?')
  assert.equal(t.running, false, 'a closed turn is not running')
  assert.equal(t.hasError, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('a transcript from before turn_ended existed is not reported as mid-turn', async () => {
  // The older corpus carries no markers at all. Reading "no marker" as "still working" would
  // light up every historical thread on the map.
  const home = await fakeCursor('tmp', [
    askedFor('<user_query>old thread</user_query>'),
    { role: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  ])
  const h = await cursorWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.running, false)
  await fsp.rm(home, { recursive: true, force: true })
})

test('a failed turn is an error, and an open turn is running', async () => {
  const home = await fakeCursor('tmp', [
    askedFor('<user_query>do it</user_query>'),
    { type: 'turn_ended', status: 'error' },
  ])
  const h = await cursorWith(home)
  const [t] = await h.scanThreads()
  assert.equal(t.hasError, true)
  await fsp.rm(home, { recursive: true, force: true })
})

test('Cursor offers a folder link but never a per-thread one it cannot honour', async () => {
  const home = await fakeCursor('tmp', [askedFor('<user_query>hi</user_query>')])
  const h = await cursorWith(home)
  assert.equal(h.openThread({ sessionId: SESSION_ID }).ok, false)
  const opened = h.newSession('/tmp/some repo')
  assert.equal(opened.ok, true)
  assert.equal(schemeOf(opened.url), 'cursor')
  assert.ok(opened.url.includes('%20'), 'a space in the path is escaped, not left raw')
  assert.equal(h.newSession('relative/path').ok, false)
  await fsp.rm(home, { recursive: true, force: true })
})

// ── Claude Code, faked on disk ────────────────────────────────────────────────

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ago = (ms) => new Date(Date.now() - ms).toISOString()

/**
 * The adapter works out every path it reads from the home directory once, at import. So a fixture
 * home is put in place for exactly one fresh, cache-busted import and then taken away again — by
 * the time the import resolves, the paths are constants. Every variable any platform consults for
 * "home" or "app data" is swapped, or a Windows or Linux run would quietly read the real machine.
 */
const HOME_VARS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME']

async function fakeClaude() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-fixture-'))
  const saved = Object.fromEntries(HOME_VARS.map((k) => [k, process.env[k]]))
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
  })
  try {
    const h = (await import(`../server/harnesses/claude-code.mjs?${home}`)).default
    return { h, cleanup: () => fsp.rm(home, { recursive: true, force: true }) }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** A transcript where the CLI would put it: under a folder named after its cwd, encoded. */
async function writeTranscript(h, cwd, id, records) {
  const folder = path.join(h.paths.CLI_PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await fsp.mkdir(folder, { recursive: true })
  const file = path.join(folder, `${id}.jsonl`)
  await fsp.writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

/** One desktop-app session record: `claude-code-sessions/<account>/<org>/local_*.json`. */
async function writeDesktopRecord(h, record) {
  const org = path.join(h.paths.DESKTOP_SESSIONS, 'account', 'org')
  await fsp.mkdir(org, { recursive: true })
  await fsp.writeFile(path.join(org, `${record.sessionId}.json`), JSON.stringify(record))
}

/** A live-process registry entry, for a pid that is — by default — this very test process. */
async function markLive(h, sessionId, pid = process.pid) {
  await fsp.mkdir(h.paths.CLI_LIVE, { recursive: true })
  await fsp.writeFile(path.join(h.paths.CLI_LIVE, `${sessionId}.json`), JSON.stringify({ pid, sessionId }))
}

const userSays = (text, fields) => ({
  type: 'user', uuid: randomUUID(), parentUuid: null, message: { role: 'user', content: text }, ...fields,
})
const answers = (fields, content = [{ type: 'text', text: 'done' }]) => ({
  type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', content, stop_reason: 'end_turn' }, ...fields,
})
const desktopId = () => `local_${randomUUID()}`

// A space, a trailing space and a hyphen: everything the folder-name encoding flattens.
const REPO = '/Volumes/Work Drive /Clients/my-repo'

test('a transcript whose first record outgrows the head still lands in its own repo and worktree', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const cwd = `${REPO}/.claude/worktrees/phase-2`
    const id = randomUUID()
    // The shape an SDK session handed a whole document takes: the prompt, twice, before any cwd.
    const prompt = 'p'.repeat(200 * 1024)
    await writeTranscript(h, cwd, id, [
      { type: 'queue-operation', operation: 'enqueue', timestamp: ago(2 * MINUTE), sessionId: id, content: prompt },
      userSays(prompt, { sessionId: id, cwd, timestamp: ago(2 * MINUTE) }),
    ])
    const [t] = await h.scanThreads()
    assert.equal(t.project, 'my-repo')
    assert.equal(t.projectPath, REPO)
    assert.equal(t.worktree, 'phase-2')
    assert.equal(t.cwd, cwd)
    assert.ok(t.title.length <= 300, `a pasted prompt makes a title, not a ${t.title.length}-character one`)
  } finally {
    await cleanup()
  }
})

test('a transcript that never names its cwd borrows one that encodes to its folder, and never guesses', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const sibling = randomUUID()
    await writeTranscript(h, REPO, sibling, [userSays('hi', { sessionId: sibling, cwd: REPO, timestamp: ago(HOUR) })])
    // No record in either of these carries a cwd at all.
    const orphan = randomUUID()
    await writeTranscript(h, `${REPO}/.claude/worktrees/wt-a`, orphan, [{ type: 'summary', summary: 'lost one' }])
    const stray = randomUUID()
    await writeTranscript(h, '/nowhere/at-all', stray, [{ type: 'summary', summary: 'stray' }])

    const byId = Object.fromEntries((await h.scanThreads()).map((t) => [t.id, t]))
    const o = byId[`claude-code:${orphan}`]
    assert.equal(o.project, 'my-repo')
    assert.equal(o.projectPath, REPO)
    assert.equal(o.worktree, 'wt-a')
    assert.equal(byId[`claude-code:${stray}`].projectPath, '', 'no folder is better than a made-up one')
  } finally {
    await cleanup()
  }
})

test('a thread is as recent as its last timestamped record, not a metadata write months later', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const id = randomUUID()
    const cwd = '/tmp/demo'
    const spoke = ago(10 * DAY)
    const file = await writeTranscript(h, cwd, id, [
      userSays('hello', { sessionId: id, cwd, timestamp: spoke }),
      answers({ sessionId: id, cwd, timestamp: spoke }),
      // What the desktop app appends long afterwards, with no timestamp of its own.
      { type: 'custom-title', customTitle: 'renamed later', sessionId: id },
      { type: 'mode', mode: 'default', sessionId: id },
    ])
    const now = new Date()
    await fsp.utimes(file, now, now)
    const [t] = await h.scanThreads()
    assert.equal(t.lastActivityAt, Date.parse(spoke))
    assert.equal(t.title, 'renamed later')
  } finally {
    await cleanup()
  }
})

test('a last record bigger than the tail still dates the thread, not the metadata after it', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const id = randomUUID()
    const cwd = '/tmp/demo'
    const spoke = ago(10 * DAY)
    const file = await writeTranscript(h, cwd, id, [
      userSays('take a screenshot', { sessionId: id, cwd, timestamp: spoke }),
      // A screenshot or a long tool result: one record longer than the whole 64 KiB tail.
      answers({ sessionId: id, cwd, timestamp: spoke }, [{ type: 'text', text: 'x'.repeat(80 * 1024) }]),
      { type: 'custom-title', customTitle: 'renamed later', sessionId: id },
      { type: 'mode', mode: 'default', sessionId: id },
    ])
    const now = new Date()
    await fsp.utimes(file, now, now)
    const [t] = await h.scanThreads()
    assert.equal(t.lastActivityAt, Date.parse(spoke), 'no timestamp in the window is not "dated by mtime"')
    assert.equal(t.title, 'renamed later')
  } finally {
    await cleanup()
  }
})

test('a session that moved into a worktree reports the worktree, and the branch it is on now', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const wt = `${REPO}/.claude/worktrees/feature-x`
    const id = randomUUID()
    // The transcript moves with the session, so it lives in the worktree's folder.
    await writeTranscript(h, wt, id, [
      userSays('start', { sessionId: id, cwd: REPO, gitBranch: 'main', timestamp: ago(HOUR) }),
      { type: 'relocated', sessionId: id, relocatedCwd: wt },
      userSays('carry on', { sessionId: id, cwd: wt, gitBranch: 'worktree-feature-x', timestamp: ago(50 * MINUTE) }),
    ])
    const [t] = await h.scanThreads()
    assert.equal(t.cwd, wt)
    assert.equal(t.worktree, 'feature-x')
    assert.equal(t.project, 'my-repo')
    assert.equal(t.gitBranch, 'worktree-feature-x')
    assert.equal(t.ref.cwd, wt, 'resuming has to happen where the session is, not where it began')
  } finally {
    await cleanup()
  }
})

test('a session stays in its worktree after the move has scrolled out of the tail', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const wt = `${REPO}/.claude/worktrees/feature-x`
    const id = randomUUID()
    const there = { sessionId: id, cwd: wt, gitBranch: 'worktree-feature-x' }
    // The move is written once. A few big tool results after it and it is no longer in the last 64 KiB.
    const big = [{ type: 'text', text: 'x'.repeat(20 * 1024) }]
    const work = [1, 2, 3, 4, 5].map((n) => answers({ ...there, timestamp: ago((50 - n) * MINUTE) }, big))
    await writeTranscript(h, wt, id, [
      userSays('start', { sessionId: id, cwd: REPO, gitBranch: 'main', timestamp: ago(HOUR) }),
      { type: 'relocated', sessionId: id, relocatedCwd: wt },
      userSays('carry on', { ...there, timestamp: ago(50 * MINUTE) }),
      ...work,
    ])
    const [t] = await h.scanThreads()
    assert.equal(t.cwd, wt)
    assert.equal(t.worktree, 'feature-x')
    assert.equal(t.ref.cwd, wt, 'resuming has to happen where the session is, not where it began')
  } finally {
    await cleanup()
  }
})

test('a desktop record from before focus was tracked is not a thread that was never opened', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const old = Date.now() - 30 * DAY
    const recent = Date.now() - MINUTE
    // No `lastFocusedAt` key at all — the app did not write one back then.
    await writeDesktopRecord(h, { sessionId: desktopId(), cwd: '/tmp/demo', title: 'old', createdAt: old, lastActivityAt: old })
    await writeDesktopRecord(h, { sessionId: desktopId(), cwd: '/tmp/demo', title: 'new', createdAt: recent, lastActivityAt: recent })
    // The key present, and the thread moved on after it: unread exactly as before.
    await writeDesktopRecord(h, {
      sessionId: desktopId(), cwd: '/tmp/demo', title: 'moved on', createdAt: old, lastActivityAt: old + 1000, lastFocusedAt: old,
    })
    const byTitle = Object.fromEntries((await h.scanThreads()).map((t) => [t.title, t]))
    assert.equal(byTitle.old.unread, false, 'months old, never stamped: unknowable, so not asking')
    assert.equal(byTitle.new.unread, true, 'a new thread nobody has opened yet still asks')
    assert.equal(byTitle['moved on'].unread, true)
    assert.equal('hasFocusStamp' in byTitle.old, false, 'bookkeeping stays inside the adapter')
  } finally {
    await cleanup()
  }
})

test("a copy of a thread's transcript is that thread, not a second astronaut", async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const cwd = '/tmp/demo'
    const sid = randomUUID()
    const copy = randomUUID()
    const convo = [
      userSays('hello', { sessionId: sid, cwd, timestamp: ago(2 * HOUR) }),
      answers({ sessionId: sid, cwd, timestamp: ago(2 * HOUR - MINUTE) }),
    ]
    await writeTranscript(h, cwd, sid, convo)
    // A fork or import: the same records, the same session ids, and the app's own title on the end.
    // Neither has a desktop record, so where the copy's conversation ends is all that can fold it.
    await writeTranscript(h, cwd, copy, [
      ...convo,
      { type: 'custom-title', customTitle: 'copy', sessionId: copy },
    ])
    assert.deepEqual((await h.scanThreads()).map((t) => t.id), [`claude-code:${sid}`])
  } finally {
    await cleanup()
  }
})

test('a copy whose original is no longer on disk stays a thread of its own', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const cwd = '/tmp/demo'
    const gone = randomUUID()
    const copy = randomUUID()
    // The conversation ends in another session's records, but that session's transcript was deleted:
    // there is nothing to fold it into, and folding it anyway would lose the conversation outright.
    await writeTranscript(h, cwd, copy, [
      userSays('hello', { sessionId: gone, cwd, timestamp: ago(2 * HOUR) }),
      answers({ sessionId: gone, cwd, timestamp: ago(2 * HOUR - MINUTE) }),
      { type: 'custom-title', customTitle: 'copy', sessionId: copy },
    ])
    assert.deepEqual((await h.scanThreads()).map((t) => t.id), [`claude-code:${copy}`])
  } finally {
    await cleanup()
  }
})

test('a transcript the desktop app superseded is folded, but one that carried on after it is not', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const cwd = '/tmp/demo'
    const began = Date.now() - 3 * HOUR
    const root = randomUUID()
    const original = randomUUID()
    const current = randomUUID()
    const diverged = randomUUID()
    const opening = (sessionId) => userSays('start', { uuid: root, sessionId, cwd, timestamp: new Date(began).toISOString() })
    // The file the thread began in, left behind when the app moved the conversation on.
    await writeTranscript(h, cwd, original, [
      opening(original),
      answers({ sessionId: original, cwd, timestamp: new Date(began + MINUTE).toISOString() }),
    ])
    // The transcript the desktop record points at now: the same opening, then more.
    await writeTranscript(h, cwd, current, [
      opening(original),
      userSays('more', { sessionId: current, cwd, parentUuid: root, timestamp: new Date(began + 10 * MINUTE).toISOString() }),
      answers({ sessionId: current, cwd, timestamp: new Date(began + 11 * MINUTE).toISOString() }),
    ])
    // Same opening, but it did something after the thread's last activity: a continuation.
    await writeTranscript(h, cwd, diverged, [
      opening(diverged),
      answers({ sessionId: diverged, cwd, timestamp: new Date(began + 20 * MINUTE).toISOString() }),
    ])
    await writeDesktopRecord(h, {
      sessionId: desktopId(), cliSessionId: current, cwd, title: 'the thread',
      createdAt: began, lastActivityAt: began + 11 * MINUTE, lastFocusedAt: Date.now(),
    })
    const ids = (await h.scanThreads()).map((t) => t.id).sort()
    assert.deepEqual(ids, [`claude-code:${current}`, `claude-code:${diverged}`].sort())
  } finally {
    await cleanup()
  }
})

test('looking at a thread does not hide a transcript that carried on after it', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const cwd = '/tmp/demo'
    const began = Date.now() - 3 * HOUR
    const at = (ms) => new Date(began + ms).toISOString()
    const root = randomUUID()
    const original = randomUUID()
    const current = randomUUID()
    const diverged = randomUUID()
    const opening = (sessionId) => userSays('start', { uuid: root, sessionId, cwd, timestamp: at(0) })
    await writeTranscript(h, cwd, original, [
      opening(original),
      answers({ sessionId: original, cwd, timestamp: at(MINUTE) }),
    ])
    // The thread's own transcript last wrote at +11 minutes…
    await writeTranscript(h, cwd, current, [
      opening(original),
      userSays('more', { sessionId: current, cwd, parentUuid: root, timestamp: at(10 * MINUTE) }),
      answers({ sessionId: current, cwd, timestamp: at(11 * MINUTE) }),
    ])
    // …and this one at +20: a continuation, however recently somebody looked at the thread.
    await writeTranscript(h, cwd, diverged, [
      opening(diverged),
      answers({ sessionId: diverged, cwd, timestamp: at(20 * MINUTE) }),
    ])
    // No `lastActivityAt`: the only recent stamp the record has is when it was last looked at.
    await writeDesktopRecord(h, {
      sessionId: desktopId(), cliSessionId: current, cwd, title: 'the thread',
      createdAt: began, lastFocusedAt: Date.now(),
    })
    const ids = (await h.scanThreads()).map((t) => t.id).sort()
    assert.deepEqual(ids, [`claude-code:${current}`, `claude-code:${diverged}`].sort())
  } finally {
    await cleanup()
  }
})

test('a live thread whose background agents are still writing is working, not waiting on you', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const id = randomUUID()
    const cwd = '/tmp/demo'
    const file = await writeTranscript(h, cwd, id, [
      userSays('run the audit', { sessionId: id, cwd, timestamp: ago(5 * MINUTE) }),
      answers({ sessionId: id, cwd, timestamp: ago(4 * MINUTE) }), // handed the turn back…
    ])
    await markLive(h, id)
    // …while a workflow it started carries on beside the transcript.
    const agentLog = path.join(path.dirname(file), id, 'subagents', 'workflows', 'wf_1', 'agent-a.jsonl')
    await fsp.mkdir(path.dirname(agentLog), { recursive: true })
    await fsp.writeFile(agentLog, '{}\n')

    let [t] = await h.scanThreads()
    assert.equal(t.running, true, 'the workflow it started is still going')

    // The workflow finishes: its last write drifts out of the window, and the turn is yours again.
    const finished = new Date(Date.now() - 3 * MINUTE)
    await fsp.utimes(agentLog, finished, finished)
    ;[t] = await h.scanThreads()
    assert.equal(t.running, false)
    assert.equal(t.unread, true)
    assert.equal('handedBack' in t, false, 'bookkeeping stays inside the adapter')
  } finally {
    await cleanup()
  }
})

test('a thread that ran an agent and then answered is waiting on you, not still working', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const id = randomUUID()
    const cwd = '/tmp/demo'
    const file = await writeTranscript(h, cwd, id, [
      userSays('look into it', { sessionId: id, cwd, timestamp: ago(3 * MINUTE) }),
      answers({ sessionId: id, cwd, timestamp: ago(30 * 1000) }), // handed the turn back 30 s ago
    ])
    await markLive(h, id)
    // A foreground agent writes beside the transcript too, and its last write came before the answer.
    const agentLog = path.join(path.dirname(file), id, 'subagents', 'agent-a.jsonl')
    await fsp.mkdir(path.dirname(agentLog), { recursive: true })
    await fsp.writeFile(agentLog, '{}\n')
    const wrote = new Date(Date.now() - MINUTE)
    await fsp.utimes(agentLog, wrote, wrote)

    const [t] = await h.scanThreads()
    assert.equal(t.running, false, 'the agent finished before the thread handed back')
    assert.equal(t.unread, true)
  } finally {
    await cleanup()
  }
})

test('a thread you looked at after it handed the turn back is not asking again', async () => {
  const { h, cleanup } = await fakeClaude()
  try {
    const id = randomUUID()
    const cwd = '/tmp/demo'
    await writeTranscript(h, cwd, id, [
      userSays('question', { sessionId: id, cwd, timestamp: ago(5 * MINUTE) }),
      answers({ sessionId: id, cwd, timestamp: ago(4 * MINUTE) }),
    ])
    await markLive(h, id)
    await writeDesktopRecord(h, {
      sessionId: desktopId(), cliSessionId: id, cwd, title: 'answered here',
      createdAt: Date.now() - 5 * MINUTE, lastActivityAt: Date.now() - 4 * MINUTE, lastFocusedAt: Date.now(),
    })
    const [t] = await h.scanThreads()
    assert.equal(t.running, false)
    assert.equal(t.unread, false)
  } finally {
    await cleanup()
  }
})

test(
  'a live session whose process we may not signal still counts as live',
  // pid 1 belongs to the system: signalling it from an ordinary user is EPERM, not ESRCH.
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    const { h, cleanup } = await fakeClaude()
    try {
      const id = randomUUID()
      const cwd = '/tmp/demo'
      await writeTranscript(h, cwd, id, [
        userSays('go', { sessionId: id, cwd, timestamp: ago(MINUTE) }),
        answers({ sessionId: id, cwd, timestamp: ago(30 * 1000) }, [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      ])
      await markLive(h, id, 1)
      const [t] = await h.scanThreads()
      assert.equal(t.running, true, 'mid-turn, with a process that exists')
    } finally {
      await cleanup()
    }
  }
)

test("a new conversation's folder is %-encoded, the way the app's own Finder quick action sends it", async () => {
  // URLSearchParams form-encodes a space as `+`, which a handler decoding with decodeURIComponent
  // reads as a literal plus — a folder that does not exist. %20 reads the same under either parser.
  const { url } = await claudeCode.newSession('/tmp/Claude code ')
  assert.equal(url, 'claude://code/new?folder=%2Ftmp%2FClaude%20code%20')
  assert.equal(new URL(url).searchParams.get('folder'), '/tmp/Claude code ')
  assert.equal(decodeURIComponent(url.split('folder=')[1]), '/tmp/Claude code ')
  assert.equal(codex.newSession('/tmp/some repo').url, 'codex://threads/new?path=%2Ftmp%2Fsome%20repo')
})

// ── Claude Cowork, faked on disk ──────────────────────────────────────────────

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'

/** A fake Cowork store. The adapter reads its root once, at import, so each store gets a fresh import. */
async function fakeCowork() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cowork-fixture-'))
  const org = path.join(root, ACCOUNT, ORG)
  await fsp.mkdir(org, { recursive: true })
  process.env.BOT_CROSSING_COWORK_SESSIONS = root
  try {
    const h = (await import(`../server/harnesses/claude-cowork.mjs?${root}`)).default
    return { h, root, org, cleanup: () => fsp.rm(root, { recursive: true, force: true }) }
  } finally {
    delete process.env.BOT_CROSSING_COWORK_SESSIONS
  }
}

/** One session record and its same-named session folder, the way the app lays them out. */
async function writeCoworkSession(org, fields = {}) {
  const sessionId = fields.sessionId || `local_${randomUUID()}`
  const record = {
    cliSessionId: randomUUID(), title: 'a session', createdAt: Date.now() - HOUR, lastActivityAt: Date.now() - HOUR,
    model: 'claude-opus-5', isArchived: false, userSelectedFolders: [], hostLoopMode: true, ...fields, sessionId,
  }
  const file = path.join(org, `${sessionId}.json`)
  await fsp.writeFile(file, JSON.stringify(record))
  const dir = path.join(org, sessionId)
  await fsp.mkdir(dir, { recursive: true })
  return { dir, file, record }
}

test('a recent Cowork session joins the zone of its first folder that still exists', async () => {
  const { h, root, org, cleanup } = await fakeCowork()
  try {
    const folder = path.join(root, 'Work Folder ')
    await fsp.mkdir(folder)
    const placed = await writeCoworkSession(org, { title: 'placed', userSelectedFolders: ['/nowhere/gone', folder] })
    const loose = await writeCoworkSession(org, { title: 'loose' })
    // Older than the window, file and record alike: never on the map.
    const old = await writeCoworkSession(org, { title: 'old', lastActivityAt: Date.now() - 40 * DAY })
    const then = new Date(Date.now() - 40 * DAY)
    await fsp.utimes(old.file, then, then)

    const byTitle = Object.fromEntries((await h.scanThreads()).map((t) => [t.title, t]))
    assert.deepEqual(Object.keys(byTitle).sort(), ['loose', 'placed'])
    const t = byTitle.placed
    assert.equal(t.id, `claude-cowork:${placed.record.sessionId}`)
    assert.equal(t.project, 'Work Folder ')
    assert.equal(t.projectPath, folder)
    assert.equal(t.cwd, folder)
    assert.equal(t.model, 'claude-opus-5')
    assert.equal(t.source, 'cowork')
    assert.equal(t.canOpen, false)
    assert.equal(t.unread, false, 'Cowork keeps no focus history')
    assert.equal(byTitle.loose.project, 'Cowork')
    assert.equal(byTitle.loose.projectPath, '')
    void loose
  } finally {
    await cleanup()
  }
})

test('nothing past the whitelist reaches a Cowork thread: not the prompt, the account, or the files beside it', async () => {
  const { h, org, cleanup } = await fakeCowork()
  try {
    const { dir } = await writeCoworkSession(org, {
      title: 'guarded',
      systemPrompt: 'MARKER-PROMPT',
      emailAddress: 'MARKER-EMAIL',
      accountName: 'MARKER-ACCOUNT',
      initialMessage: 'MARKER-FIRST-MESSAGE',
      remoteMcpServersConfig: { server: 'MARKER-MCP' },
    })
    await fsp.writeFile(path.join(dir, '.credentials.json'), '{"token":"MARKER-CREDENTIALS"}')
    await fsp.writeFile(path.join(dir, '.audit-key'), 'MARKER-AUDIT-KEY')
    await fsp.writeFile(path.join(dir, 'audit.jsonl'), '{"type":"result","text":"MARKER-AUDIT"}\n')
    const out = JSON.stringify(await h.scanThreads())
    assert.ok(out.includes('guarded'), 'the session itself is there')
    assert.ok(!/MARKER-/.test(out), `nothing sensitive leaks: ${out.match(/MARKER-[A-Z-]+/g)}`)
  } finally {
    await cleanup()
  }
})

test('Cowork offers no link it cannot honour, and starts sessions the way the app\'s own quick action does', async () => {
  const { h, cleanup } = await fakeCowork()
  try {
    assert.equal(await h.detect(), true)
    assert.equal(h.openThread({ sessionId: `local_${randomUUID()}` }).ok, false)
    assert.equal(h.newSession('/tmp/some folder ').url, 'claude://cowork/new?folder=%2Ftmp%2Fsome%20folder%20')
  } finally {
    await cleanup()
  }
  process.env.BOT_CROSSING_COWORK_SESSIONS = path.join(os.tmpdir(), `no-cowork-${randomUUID()}`)
  const absent = (await import(`../server/harnesses/claude-cowork.mjs?${process.env.BOT_CROSSING_COWORK_SESSIONS}`)).default
  delete process.env.BOT_CROSSING_COWORK_SESSIONS
  assert.equal(await absent.detect(), false)
  assert.deepEqual(await absent.scanThreads(), [])
})
