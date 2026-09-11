# Cowork Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Claude desktop app's Cowork sessions on the map — recent interactive sessions and one astronaut per enabled routine — through a new read-only harness adapter.

**Architecture:** One new file, `server/harnesses/claude-cowork.mjs`, registered in `server/harnesses/index.mjs`. It reads a pinned set of files in the Cowork store, cuts each record to a field whitelist at parse, and returns threads in the existing Thread shape. Nothing in `scan.mjs`, `api.mjs` or `src/` changes. Three tasks, strictly in order; later "Replace" blocks quote the file as earlier tasks left it.

**Tech Stack:** Node ≥ 22.13 ESM, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-11-cowork-adapter-design.md`

## Global Constraints

- Read-only. Nothing is written anywhere; nothing is read from or executed inside an application bundle. The adapter opens only: org-folder listings, `local_<uuid>.json` records, `scheduled-tasks.json`, a session's `.claude/projects/*/` listing + transcript stat, and its `.claude/sessions/*.json` registry. Never `.credentials.json`, `.audit-key`, `.claude.json`, `cowork_*.json`, `audit.jsonl`, `outputs/`, `uploads/`.
- No new dependencies. House style: no semicolons, single quotes, 2-space indent, ~110 columns; comments explain why.
- Tests use synthetic fixtures only (public fork) and never bind a socket. Run only `node --test test/harness.test.mjs` (and `test/api.test.mjs` where named) — never `npm test` or `test/state.test.mjs` (sockets crash the sandbox).
- Commit messages: a plain sentence ending with a `Co-Authored-By:` trailer naming the model that wrote it. Never push.
- Worktree: `.worktrees/cowork`, branch `feat/cowork`.

---

### Task C1: the adapter — recent interactive sessions, placed by folder, whitelisted

**Files:**
- Create: `server/harnesses/claude-cowork.mjs`
- Modify: `server/harnesses/index.mjs`, `test/api.test.mjs` (one line), `test/harness.test.mjs`

**Interfaces:**
- Produces (module-private, used by C2/C3): `STORE`, `WINDOW_MS`, `UUID`, `RECORD`, `ID(raw)`, `orgDirs()`, `keep(record)`, `recentRecords(orgs, now)` → whitelisted records each with `sessionDir`, `firstFolder(folders)`, `threadFor(id, run, { folders, routine, createdAt, fallbackTitle })`, `scanThreads()`. Default export `{ id: 'claude-cowork', name: 'Claude Cowork', detect, scanThreads, openThread, newSession, paths: { STORE } }`. Test helpers `ACCOUNT`, `ORG`, `fakeCowork()`, `writeCoworkSession(org, fields)`.

- [ ] **Step 1: Write the failing tests.** Append to `test/harness.test.mjs` (it already imports `randomUUID`, `fsp`, `os`, `path`, and defines `HOUR`, `DAY`):

```js
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
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → the three new tests FAIL (`Cannot find module …claude-cowork.mjs`).

- [ ] **Step 3: Implement.** Create `server/harnesses/claude-cowork.mjs`:

```js
/**
 * Harness adapter: Claude Cowork — the desktop app's agent sessions and its scheduled routines.
 *
 * Cowork keeps one JSON record per session at
 * `<Claude app data>/local-agent-mode-sessions/<account>/<org>/local_<uuid>.json`, and beside each
 * a same-named folder where that session's CLI ran: its transcript under `.claude/projects/<folder>/`,
 * its live-process registry under `.claude/sessions/`. Two things about that store shape this file:
 *
 *   - **Volume.** A routine that runs every morning leaves a record per run — hundreds of them — so
 *     a routine is one astronaut built from its runs, and interactive sessions appear only while
 *     they are recent.
 *   - **What sits beside the records.** Session folders hold credentials, audit keys and whatever
 *     the session produced, and each record carries its full system prompt, its MCP configuration
 *     and the account's name and email. The read surface is pinned to the handful of files named
 *     below, and a record is cut down to a short list of fields the moment it is parsed.
 *
 * Read-only, no subprocess, and nothing is ever read from inside `Claude.app`.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exists, listDirs, listFiles, num } from '../lib/fsutil.mjs'

const HOME = os.homedir()

/** Where the Claude desktop app keeps its data: Electron's `userData` for an app named "Claude". */
function claudeDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude')
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude')
    default:
      return path.join(HOME, 'Library', 'Application Support', 'Claude')
  }
}

const STORE = process.env.BOT_CROSSING_COWORK_SESSIONS || path.join(claudeDataDir(), 'local-agent-mode-sessions')

/**
 * How far back a session — or a routine's latest run — has to reach to be on the map. A year of
 * Cowork is a thousand records; the colony is a picture of what is going on, not an archive.
 */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RECORD = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i

/** Prefixed, per the contract in `server/harnesses/README.md`. */
const ID = (raw) => `claude-cowork:${raw}`

/**
 * The `<account>/<org>` folders, entered only where both names are UUIDs: the store also holds a
 * `skills-plugin` folder and the like, which are not sessions.
 */
async function orgDirs() {
  const out = []
  for (const account of await listDirs(STORE)) {
    if (!UUID.test(path.basename(account))) continue
    for (const org of await listDirs(account)) if (UUID.test(path.basename(org))) out.push(org)
  }
  return out
}

const text = (v) => (typeof v === 'string' ? v : '')
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [])

/**
 * A record cut down to what the colony uses. Nothing else survives the parse — not the system
 * prompt, not the MCP configuration, not the account's name or email — and only this is cached.
 */
function keep(r) {
  return {
    sessionId: text(r.sessionId),
    cliSessionId: text(r.cliSessionId),
    title: text(r.title),
    createdAt: num(r.createdAt),
    lastActivityAt: num(r.lastActivityAt),
    model: text(r.model),
    isArchived: r.isArchived === true,
    isStarred: r.isStarred === true,
    userSelectedFolders: strings(r.userSelectedFolders),
    scheduledTaskId: text(r.scheduledTaskId),
    sessionType: text(r.sessionType),
    hasError: Boolean(r.error),
    hostLoopMode: r.hostLoopMode === true,
  }
}

/** Parsed records, against each file's mtime and size: a 1.8MB record is parsed once, not per poll. */
const recordCache = new Map()

/**
 * Every record touched within the window, whitelisted. A record's `lastActivityAt` is never later
 * than its file's mtime, so a file untouched for longer than the window cannot hold anything recent
 * and is not even opened — which is what keeps a thousand-record store to a stat each.
 */
async function recentRecords(orgs, now) {
  const out = []
  for (const org of orgs) {
    for (const file of await listFiles(org, (n) => RECORD.test(n))) {
      let st
      try {
        st = await fsp.stat(file)
      } catch {
        continue
      }
      if (now - st.mtimeMs > WINDOW_MS) continue
      const hit = recordCache.get(file)
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
        if (hit.record) out.push(hit.record)
        continue
      }
      let record
      try {
        const kept = keep(JSON.parse(await fsp.readFile(file, 'utf8')))
        record = kept.sessionId ? { ...kept, sessionDir: file.slice(0, -'.json'.length) } : null
      } catch {
        continue // mid-write: not cached, so the next poll tries again
      }
      recordCache.set(file, { mtime: st.mtimeMs, size: st.size, record })
      if (record) out.push(record)
    }
  }
  return out
}

/** The first folder that is still a directory on this machine, or `''` — checked, never assumed. */
async function firstFolder(folders) {
  for (const folder of folders) {
    if (!path.isAbsolute(folder)) continue
    try {
      if ((await fsp.stat(folder)).isDirectory()) return folder
    } catch {
      /* moved or deleted since the session ran */
    }
  }
  return ''
}

/**
 * One astronaut. It stands in the zone of the first folder the session was given — so a session
 * about a repo shares that repo's ground with its Claude Code threads — and in one shared `Cowork`
 * zone when it was given none that still exists. A session's own cwd is a scratch `outputs`
 * folder inside the store, which is nobody's idea of where the work lives.
 */
async function threadFor(id, run, { folders, routine = '', createdAt = 0, fallbackTitle = '' }) {
  const folder = await firstFolder(folders)
  return {
    id,
    title: run.title || fallbackTitle || 'Untitled session',
    preview: '',
    project: folder ? path.basename(folder) : 'Cowork',
    projectPath: folder,
    worktree: '',
    cwd: folder,
    gitBranch: '',
    model: run.model,
    effort: '',
    createdAt: createdAt || run.createdAt || run.lastActivityAt,
    lastActivityAt: run.lastActivityAt,
    // Cowork keeps no focus history, so "have you read this" is unknowable rather than false.
    lastFocusedAt: 0,
    unread: false,
    running: false,
    hasError: run.hasError,
    starred: run.isStarred,
    routine,
    prState: '',
    archived: run.isArchived,
    sizeBytes: 0,
    source: 'cowork',
    canOpen: false,
    ref: { sessionId: run.sessionId },
  }
}

async function scanThreads() {
  const now = Date.now()
  const orgs = await orgDirs()
  const threads = []
  for (const record of await recentRecords(orgs, now)) {
    if (now - record.lastActivityAt > WINDOW_MS) continue
    // Scheduled runs belong to their routine, not to the map one by one.
    if (record.scheduledTaskId || record.sessionType === 'scheduled') continue
    threads.push(await threadFor(ID(record.sessionId), record, { folders: record.userSelectedFolders }))
  }
  return threads
}

/**
 * No verified link opens an existing Cowork session — `claude://claude.ai/epitaxy/<id>` is the Code
 * surface's — and a guessed route would be a button that silently does nothing. The UI greys the
 * button and shows this instead.
 */
function openThread() {
  return { ok: false, error: 'Cowork has no link to a single session yet — open it from the Cowork sidebar.' }
}

/**
 * A new Cowork session on a folder, in the form the app's own "send to Cowork" quick action uses:
 * the folder percent-encoded, so a space is `%20` under any parser.
 */
function newSession(dir) {
  return { ok: true, url: `claude://cowork/new?folder=${encodeURIComponent(dir)}` }
}

const detect = () => exists(STORE)

export default {
  id: 'claude-cowork',
  name: 'Claude Cowork',
  detect,
  scanThreads,
  openThread,
  newSession,
  paths: { STORE },
}
```

In `server/harnesses/index.mjs`, replace

```js
import claudeCode from './claude-code.mjs'
import codex from './codex.mjs'
import cursor from './cursor.mjs'

export const HARNESSES = [claudeCode, codex, cursor]
```

with

```js
import claudeCode from './claude-code.mjs'
import claudeCowork from './claude-cowork.mjs'
import codex from './codex.mjs'
import cursor from './cursor.mjs'

export const HARNESSES = [claudeCode, claudeCowork, codex, cursor]
```

In `test/api.test.mjs`, replace `delete process.env.BOT_CROSSING_CURSOR_PROJECTS` with

```js
delete process.env.BOT_CROSSING_CURSOR_PROJECTS
delete process.env.BOT_CROSSING_COWORK_SESSIONS
```

- [ ] **Step 4: Run to verify pass.** `node --check server/harnesses/claude-cowork.mjs && node --test test/harness.test.mjs && node --test test/api.test.mjs` → all PASS.

- [ ] **Step 5: Commit.** `git add server/harnesses/claude-cowork.mjs server/harnesses/index.mjs test/harness.test.mjs test/api.test.mjs` — message: `Show recent Cowork sessions on the map, in the zone of the folder they were given`

---

### Task C2: one astronaut per enabled routine

**Files:** Modify `server/harnesses/claude-cowork.mjs`, `test/harness.test.mjs`

**Interfaces:**
- Consumes: `orgDirs`, `recentRecords`, `threadFor`, `ID`, `WINDOW_MS` (C1).
- Produces: `TASK_ID`, `routinesIn(org) → Map<taskId, { folders: string[] }>`; routine threads with id `claude-cowork:task:<taskId>`.

- [ ] **Step 1: Write the failing test.** Append:

```js
test('an enabled routine is one astronaut, however often it has run; a disabled one is not on the map', async () => {
  const { h, root, org, cleanup } = await fakeCowork()
  try {
    const folder = path.join(root, 'Briefs')
    await fsp.mkdir(folder)
    await fsp.writeFile(path.join(org, 'scheduled-tasks.json'), JSON.stringify({
      scheduledTasks: [
        { id: 'morning-brief', enabled: true, userSelectedFolders: [folder] },
        { id: 'old-sync', enabled: false, userSelectedFolders: [] },
        { id: 'quiet-one', enabled: true, userSelectedFolders: [] },
      ],
    }))
    const run = (task, ago, extra = {}) => writeCoworkSession(org, {
      scheduledTaskId: task, sessionType: 'scheduled', createdAt: Date.now() - ago, lastActivityAt: Date.now() - ago, ...extra,
    })
    await run('morning-brief', 3 * DAY, { title: 'brief, three days ago' })
    await run('morning-brief', 2 * DAY, { title: 'brief, two days ago' })
    await run('morning-brief', HOUR, { title: 'brief, latest', error: 'rate limited' })
    await run('old-sync', HOUR, { title: 'disabled routine' })
    const stale = await run('quiet-one', 40 * DAY, { title: 'quiet, long ago' })
    const then = new Date(Date.now() - 40 * DAY)
    await fsp.utimes(stale.file, then, then)

    const threads = await h.scanThreads()
    assert.deepEqual(threads.map((t) => t.id), ['claude-cowork:task:morning-brief'])
    const [t] = threads
    assert.equal(t.title, 'brief, latest')
    assert.equal(t.routine, 'morning-brief')
    assert.equal(t.hasError, true, 'the latest run failed')
    assert.equal(t.project, 'Briefs', "placed by the routine's own folder when its runs name none")
    assert.ok(Math.abs(t.createdAt - (Date.now() - 3 * DAY)) < MINUTE, 'created when its first run in the window was')
  } finally {
    await cleanup()
  }
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → FAIL (no routine thread; `[]`).

- [ ] **Step 3: Implement.** In `server/harnesses/claude-cowork.mjs`:

Replace

```js
const RECORD = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
```

with

```js
const RECORD = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
/** A routine's id becomes part of a thread id, so only the app's own kebab-case shape is taken. */
const TASK_ID = /^[a-z0-9][a-z0-9-]*$/
```

Replace `/** The first folder that is still a directory on this machine, or `''` — checked, never assumed. */` with

```js
/** The routines switched on in the app, each with the folders it was given. */
async function routinesIn(org) {
  let tasks
  try {
    tasks = JSON.parse(await fsp.readFile(path.join(org, 'scheduled-tasks.json'), 'utf8')).scheduledTasks
  } catch {
    return new Map()
  }
  const out = new Map()
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.enabled !== true || typeof t.id !== 'string' || !TASK_ID.test(t.id)) continue
    out.set(t.id, { folders: strings(t.userSelectedFolders) })
  }
  return out
}

/** The first folder that is still a directory on this machine, or `''` — checked, never assumed. */
```

Replace the whole `scanThreads` function:

```js
async function scanThreads() {
  const now = Date.now()
  const orgs = await orgDirs()
  const threads = []
  for (const record of await recentRecords(orgs, now)) {
    if (now - record.lastActivityAt > WINDOW_MS) continue
    // Scheduled runs belong to their routine, not to the map one by one.
    if (record.scheduledTaskId || record.sessionType === 'scheduled') continue
    threads.push(await threadFor(ID(record.sessionId), record, { folders: record.userSelectedFolders }))
  }
  return threads
}
```

with

```js
async function scanThreads() {
  const now = Date.now()
  const orgs = await orgDirs()
  const enabled = new Map()
  for (const org of orgs) for (const [taskId, task] of await routinesIn(org)) enabled.set(taskId, task)

  const threads = []
  const runs = new Map()
  for (const record of await recentRecords(orgs, now)) {
    if (now - record.lastActivityAt > WINDOW_MS) continue
    if (record.scheduledTaskId || record.sessionType === 'scheduled') {
      // A run of a routine that has since been switched off, or of none at all, is history.
      if (!enabled.has(record.scheduledTaskId)) continue
      if (!runs.has(record.scheduledTaskId)) runs.set(record.scheduledTaskId, [])
      runs.get(record.scheduledTaskId).push(record)
      continue
    }
    threads.push(await threadFor(ID(record.sessionId), record, { folders: record.userSelectedFolders }))
  }

  /*
   * One astronaut per routine, whatever it has run since. A daily routine is hundreds of records and
   * would bury every other zone on the map; as one thread it is a place to see at a glance whether
   * this morning's run worked. Its id is the routine's, not a run's, so the astronaut stays put from
   * one day's run to the next.
   */
  for (const [taskId, list] of runs) {
    list.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    const latest = list[0]
    const folders = latest.userSelectedFolders.length ? latest.userSelectedFolders : enabled.get(taskId).folders
    const createdAt = Math.min(...list.map((r) => r.createdAt || r.lastActivityAt))
    threads.push(await threadFor(ID(`task:${taskId}`), latest, { folders, routine: taskId, createdAt, fallbackTitle: taskId }))
  }
  return threads
}
```

- [ ] **Step 4: Run to verify pass.** `node --test test/harness.test.mjs` → all PASS.

- [ ] **Step 5: Commit.** `git add server/harnesses/claude-cowork.mjs test/harness.test.mjs` — message: `Show each enabled Cowork routine as one astronaut built from its runs`

---

### Task C3: transcript size and live sessions; README

**Files:** Modify `server/harnesses/claude-cowork.mjs`, `test/harness.test.mjs`, `README.md`

**Interfaces:**
- Consumes: `threadFor`, `scanThreads` (C2 form), `UUID`.
- Produces: `ACTIVE_WINDOW_MS`, `transcriptOf(run) → { size, mtime } | null`, `isLive(run) → boolean`; `threadFor` gains a trailing `now` argument.

- [ ] **Step 1: Write the failing tests.** Append:

```js
/** A Cowork transcript where the CLI keeps it: one opaque folder down, named by the CLI, not by us. */
async function writeCoworkTranscript(dir, cliSessionId, bytes) {
  const folder = path.join(dir, '.claude', 'projects', '-sessions-truncated-name-9f3a2c')
  await fsp.mkdir(folder, { recursive: true })
  const file = path.join(folder, `${cliSessionId}.jsonl`)
  await fsp.writeFile(file, 'x'.repeat(bytes - 1) + '\n')
  return file
}

async function writeCoworkRegistry(dir, fields) {
  const folder = path.join(dir, '.claude', 'sessions')
  await fsp.mkdir(folder, { recursive: true })
  await fsp.writeFile(path.join(folder, `${fields.pid}.json`), JSON.stringify(fields))
}

test('a Cowork thread is as big as its transcript, found without decoding the folder it sits in', async () => {
  const { h, org, cleanup } = await fakeCowork()
  try {
    const { dir, record } = await writeCoworkSession(org, { title: 'sized' })
    await writeCoworkTranscript(dir, record.cliSessionId, 4096)
    const [t] = await h.scanThreads()
    assert.equal(t.sizeBytes, 4096)
  } finally {
    await cleanup()
  }
})

test('a Cowork session running on this machine now is working; a VM one, or a quiet one, is not', async () => {
  const { h, org, cleanup } = await fakeCowork()
  try {
    const live = await writeCoworkSession(org, { title: 'live' })
    await writeCoworkTranscript(live.dir, live.record.cliSessionId, 100)
    await writeCoworkRegistry(live.dir, { pid: process.pid, sessionId: live.record.cliSessionId, pidDomain: process.platform })

    // Ran in the app's VM: its pid names nothing here, so it is never probed.
    const vm = await writeCoworkSession(org, { title: 'vm', hostLoopMode: false })
    await writeCoworkTranscript(vm.dir, vm.record.cliSessionId, 100)
    await writeCoworkRegistry(vm.dir, { pid: process.pid, sessionId: vm.record.cliSessionId, pidDomain: process.platform })

    // An older registry with no pidDomain cannot say whose pid it is.
    const unknown = await writeCoworkSession(org, { title: 'unknown' })
    await writeCoworkTranscript(unknown.dir, unknown.record.cliSessionId, 100)
    await writeCoworkRegistry(unknown.dir, { pid: process.pid, sessionId: unknown.record.cliSessionId })

    // Live process, but its transcript has not moved in two hours.
    const quiet = await writeCoworkSession(org, { title: 'quiet' })
    const file = await writeCoworkTranscript(quiet.dir, quiet.record.cliSessionId, 100)
    const then = new Date(Date.now() - 2 * HOUR)
    await fsp.utimes(file, then, then)
    await writeCoworkRegistry(quiet.dir, { pid: process.pid, sessionId: quiet.record.cliSessionId, pidDomain: process.platform })

    const byTitle = Object.fromEntries((await h.scanThreads()).map((t) => [t.title, t]))
    assert.equal(byTitle.live.running, true)
    assert.equal(byTitle.vm.running, false)
    assert.equal(byTitle.unknown.running, false)
    assert.equal(byTitle.quiet.running, false)
  } finally {
    await cleanup()
  }
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → both FAIL (`sizeBytes` 0, `running` false).

- [ ] **Step 3: Implement.** In `server/harnesses/claude-cowork.mjs`:

Replace

```js
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000
```

with

```js
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How recently a live session's transcript must have moved to count as working. A process on its
 * own is not enough: one can outlive its work, and a session at rest writes nothing.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
```

Replace `/** The first folder that is still a directory on this machine, or `''` — checked, never assumed. */` with

```js
/**
 * A session's transcript: `<sessionDir>/.claude/projects/<folder>/<cliSessionId>.jsonl`. The folder is
 * the CLI's encoding of the session's cwd — lossy, and here also truncated and hash-suffixed — so it
 * is found by listing one level and asking for the exact file name, never by decoding it.
 */
async function transcriptOf(run) {
  if (!UUID.test(run.cliSessionId)) return null
  for (const dir of await listDirs(path.join(run.sessionDir, '.claude', 'projects'))) {
    try {
      const st = await fsp.stat(path.join(dir, `${run.cliSessionId}.jsonl`))
      if (st.isFile()) return { size: st.size, mtime: st.mtimeMs }
    } catch {
      /* not in this one */
    }
  }
  return null
}

/**
 * Whether the session's CLI is running on this machine now. Its registry sits in the session's own
 * folder, and a pid in it is probed only when the registry says the pid is one of this machine's
 * (`pidDomain`) and the session ran on the host: a session in the app's VM has a pid that names
 * nothing here, or worse, somebody else's process. EPERM is a process that exists and is not ours
 * to signal — alive.
 */
async function isLive(run) {
  if (!run.hostLoopMode || !UUID.test(run.cliSessionId)) return false
  for (const file of await listFiles(path.join(run.sessionDir, '.claude', 'sessions'), (n) => n.endsWith('.json'))) {
    let registry
    try {
      registry = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (registry?.sessionId !== run.cliSessionId || registry.pidDomain !== process.platform) continue
    if (!Number.isInteger(registry.pid) || registry.pid <= 0) continue
    try {
      process.kill(registry.pid, 0) // signal 0 only tests for existence
      return true
    } catch (err) {
      if (err.code === 'EPERM') return true
    }
  }
  return false
}

/** The first folder that is still a directory on this machine, or `''` — checked, never assumed. */
```

Replace

```js
async function threadFor(id, run, { folders, routine = '', createdAt = 0, fallbackTitle = '' }) {
  const folder = await firstFolder(folders)
```

with

```js
async function threadFor(id, run, { folders, routine = '', createdAt = 0, fallbackTitle = '' }, now) {
  const folder = await firstFolder(folders)
  const transcript = await transcriptOf(run)
  const live = transcript ? await isLive(run) : false
```

Replace `    running: false,` with `    running: live && now - transcript.mtime < ACTIVE_WINDOW_MS,` and `    sizeBytes: 0,` with `    sizeBytes: transcript ? transcript.size : 0,`.

In `scanThreads`, replace

```js
    threads.push(await threadFor(ID(record.sessionId), record, { folders: record.userSelectedFolders }))
```

with

```js
    threads.push(await threadFor(ID(record.sessionId), record, { folders: record.userSelectedFolders }, now))
```

and replace

```js
    threads.push(await threadFor(ID(`task:${taskId}`), latest, { folders, routine: taskId, createdAt, fallbackTitle: taskId }))
```

with

```js
    threads.push(
      await threadFor(ID(`task:${taskId}`), latest, { folders, routine: taskId, createdAt, fallbackTitle: taskId }, now)
    )
```

In `README.md`, in the "Which harnesses work" table, replace the `**[Claude Code]…` row with that row followed by:

```md
| **Claude Cowork** (Anthropic) | ✅ **Supported** — interactive sessions from the last 30 days, and one astronaut per enabled routine; placed in the zone of the first folder a session was given. Open is not available yet (no link to a single Cowork session) |
```

- [ ] **Step 4: Run to verify pass.** `node --test test/harness.test.mjs && node --test test/api.test.mjs` → all PASS.

- [ ] **Step 5: Commit.** `git add server/harnesses/claude-cowork.mjs test/harness.test.mjs README.md` — message: `Size Cowork threads by their transcript, and show the ones running now as working`

---

# After the tasks (orchestrator)

1. Full `npm test` outside the sandbox; a whole-branch review of `asmg/main..feat/cowork`.
2. Live check against the real store (counts only): threads added, routines, placement, scan time.
3. Fast-forward `asmg/main`; restart the colony.
4. The map tidy (operation): list candidates, get approval, archive/hide through the colony API only.
