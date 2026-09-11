# Audit Fixes (bundles A, B, C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the colony show what threads are really doing, stop other local pages from reading or driving the server, and stop a bad disk from wiping the colony file.

**Architecture:** Two independent tracks on disjoint files, each in its own worktree, merged into `asmg/main` at the end. **Track H** (harness) changes only `server/lib/fsutil.mjs`, `server/harnesses/claude-code.mjs`, `server/harnesses/codex.mjs`, `test/harness.test.mjs`. **Track S** (server) changes only `server/api.mjs`, `server/serve.mjs`, `vite.config.js`, `src/game/api.js`, and new files `test/support/inject.mjs`, `test/api.test.mjs`, `test/vite.test.mjs`, `test/serve.test.mjs`. Within a track, tasks run strictly in order — later tasks' "Replace" blocks quote the file as earlier tasks left it.

**Tech Stack:** Node ≥ 22.13 (ESM `.mjs`), `node:test`, Vite 7.3.6, three.js front end (untouched).

**Spec:** `docs/superpowers/specs/2026-09-11-audit-fixes-design.md`

## Global Constraints

- Nothing is written anywhere except `data/colony.json` (or `$BOT_CROSSING_DATA/colony.json`). Nothing is read from or executed inside an application bundle. No new directory listing outside what the adapters already read.
- Runtime dependencies stay exactly `three` and `@mdi/js`; no new devDependencies. Do not run `npm install` (it rewrites the lockfile) — the worktree already has `node_modules` from `npm ci`.
- House style: no semicolons, single quotes, 2-space indent, ~110 columns. Comments explain **why** — especially why the obvious approach was rejected. Match the surrounding comment density.
- New tests never bind a socket and never read the real machine. **Do not run `npm test` or `test/state.test.mjs`** — the existing state tests open loopback sockets, which crash Node inside the Claude sandbox. Run only the file named in each step. (The orchestrator runs the full suite outside the sandbox.)
- This fork is **public**: fixtures are synthetic. Never copy anything from `~/.claude`, `~/Library/Application Support/Claude` or `data/colony.json` into a test or commit.
- Commit messages follow the repo's style (a plain sentence, no prefix), ending with the trailer line `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Never `git push`. Never touch `main`, `asmg/main` or the other track's worktree.

---

## Task 0 (orchestrator): worktrees

Done by the orchestrator before any implementer starts, with the sandbox off (it writes `.git/`).

- [ ] **Step 1:** Ignore the worktree folder locally, without a tracked change:

```bash
cd "<repo>" && grep -qx '.worktrees/' .git/info/exclude || echo '.worktrees/' >> .git/info/exclude
```

- [ ] **Step 2:** Create both worktrees from `asmg/main` (which carries this plan) and install:

```bash
git worktree add .worktrees/harness -b fix/harness asmg/main
git worktree add .worktrees/server -b fix/server asmg/main
(cd .worktrees/harness && npm ci --cache "$TMPDIR/npm-cache")
(cd .worktrees/server && npm ci --cache "$TMPDIR/npm-cache")
```

- [ ] **Step 3:** Baseline, from each worktree: `node --test test/harness.test.mjs` → all pass.

---

# Track H — harness (`.worktrees/harness`, branch `fix/harness`)

### Task H1: `readRecordsUntil` — read forward past a giant first record

**Files:**
- Modify: `server/lib/fsutil.mjs` (add after `readTail`)
- Test: `test/harness.test.mjs`

**Interfaces:**
- Produces: `export async function readRecordsUntil(file, { maxBytes, until, chunkBytes = 64 * 1024 }) → Promise<object[]>` — every parsed record from the start of the file up to and including the first one for which `until(record)` is truthy; stops early at `maxBytes`.

- [ ] **Step 1: Write the failing tests.** In `test/harness.test.mjs`, change the fsutil import line from

```js
import { readTail, findExecutable } from '../server/lib/fsutil.mjs'
```

to

```js
import { readHead, readRecordsUntil, readTail, findExecutable } from '../server/lib/fsutil.mjs'
```

and add these tests directly after the existing `readTail drops the partial line…` test:

```js
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
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → FAIL: the file cannot load (`does not provide an export named 'readRecordsUntil'`).

- [ ] **Step 3: Implement.** In `server/lib/fsutil.mjs`, insert after the closing `}` of `readTail`:

```js
/**
 * Records from the start of a file, read forward until `until(record)` holds or `maxBytes` have
 * gone by — for the transcript whose first record is bigger than any head budget.
 *
 * `readHead` drops a trailing partial line so `JSON.parse` never sees half a record, and when a
 * single record is longer than the whole budget that drops *everything*: a 230KB first line read
 * through a 192KB window leaves nothing to parse, and whatever came after it is never seen. This
 * carries the partial line across reads instead, so any record that ends inside `maxBytes` arrives
 * whole. The carry is kept as bytes rather than text, so a character split across two reads is
 * decoded once, intact.
 */
export async function readRecordsUntil(file, { maxBytes, until, chunkBytes = 64 * 1024 }) {
  const fh = await fsp.open(file, 'r')
  const out = []
  try {
    const buf = Buffer.allocUnsafe(chunkBytes)
    let carry = Buffer.alloc(0)
    let pos = 0
    while (pos < maxBytes) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(chunkBytes, maxBytes - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      carry = Buffer.concat([carry, buf.subarray(0, bytesRead)])
      let nl
      while ((nl = carry.indexOf(0x0a)) !== -1) {
        const line = carry.subarray(0, nl).toString('utf8')
        carry = carry.subarray(nl + 1)
        for (const record of jsonLines(line)) {
          out.push(record)
          if (until(record)) return out
        }
      }
    }
    // A last line with no newline after it: the file ended mid-line, or the budget did. The first
    // parses; the second is half a record, and `jsonLines` drops it.
    for (const record of jsonLines(carry.toString('utf8'))) {
      out.push(record)
      if (until(record)) break
    }
    return out
  } finally {
    await fh.close()
  }
}
```

- [ ] **Step 4: Run to verify pass.** `node --test test/harness.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/lib/fsutil.mjs test/harness.test.mjs
git commit -m "Read forward past a first record bigger than the head

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task H2: find a transcript's cwd past the head; never decode a folder name

**Files:**
- Modify: `server/harnesses/claude-code.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Consumes: `readRecordsUntil` (H1).
- Produces (module-private, used by H3–H6): `encodeProjectDir(p) → string`; `resolveProjectDir(name, known: Map<string,string>) → string`; `openingMeta(entry)`; in `scanThreads`: `known` (Map), `learn(p)`, and the two-pass `loose` array of `{ id, entry, meta }`. Constants `OPENING_BYTES`, `PROMPT_CHARS`. Test helpers `MINUTE`, `HOUR`, `DAY`, `ago`, `fakeClaude`, `writeTranscript`, `writeDesktopRecord`, `markLive`, `userSays`, `answers`, `desktopId`.

- [ ] **Step 1: Write the failing tests.** In `test/harness.test.mjs`, add to the imports at the top:

```js
import { randomUUID } from 'node:crypto'
```

Append at the end of the file:

```js
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
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → the two new tests FAIL (project `'phase'`/`'a'` or similar made-up names from `decodeProjectDir`; title 200k chars).

- [ ] **Step 3: Implement** in `server/harnesses/claude-code.mjs`, as five replacements.

**3a.** Replace

```js
import { exists, findExecutable, jsonLines, listDirs, listFiles, num, readHead, readTail } from '../lib/fsutil.mjs'
```

with

```js
import {
  exists, findExecutable, jsonLines, listDirs, listFiles, num, readHead, readRecordsUntil, readTail,
} from '../lib/fsutil.mjs'
```

**3b.** Replace

```js
const HEAD_BYTES = 192 * 1024
```

with

```js
const HEAD_BYTES = 192 * 1024

/**
 * How far to read for a transcript's opening when the head cannot show it. A pasted prompt of a
 * couple of hundred thousand characters — an SDK session handed a whole document — is written
 * twice before any record carries a cwd, which puts the first one half a megabyte in. Bounded,
 * and paid once per session rather than once per poll: see `openingMeta`.
 */
const OPENING_BYTES = 2 * 1024 * 1024

/** The most of a first prompt kept. It stands in for a title and a preview, never for the prompt. */
const PROMPT_CHARS = 300
```

**3c.** Replace

```js
      if (text && !text.startsWith('<')) meta.firstPrompt = text
```

with

```js
      if (text && !text.startsWith('<')) meta.firstPrompt = text.slice(0, PROMPT_CHARS)
```

**3d.** Replace the whole `decodeProjectDir` block:

```js
/**
 * Best-effort reverse of the encoding used for project folder names: `-Users-you-Some-Dir`
 * on macOS, `C--Users-you-Some-Dir` on Windows, where the drive's colon became a dash too.
 */
function decodeProjectDir(name) {
  const drive = /^([A-Za-z])--(.*)$/.exec(name)
  if (drive) return `${drive[1]}:\\${drive[2].replace(/-/g, '\\')}`
  return name.startsWith('-') ? '/' + name.slice(1).replace(/-/g, '/') : name
}
```

with

```js
/**
 * The CLI names a transcript's folder after the cwd it ran in, with every character outside
 * [A-Za-z0-9] turned into `-`. That cannot be reversed — `/`, ` `, `.`, `_` and `-` all land on the
 * same character — so a folder name is only ever checked against a real path, never decoded into
 * one. Decoding it split `my-repo` on a drive called `Work Drive` into four made-up folders, and
 * the thread claimed a zone of its own named after the last of them.
 */
const encodeProjectDir = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-')

/** What `/.claude/worktrees/` becomes in a folder name, on either separator. */
const WORKTREE_MARK = '--claude-worktrees-'

/**
 * The cwd a transcript folder stands for, for the rare transcript that never says where it ran.
 *
 * Only paths something on this machine actually reported are candidates — another transcript's
 * cwd, a desktop record's — and one is taken only if it encodes back to exactly this folder's
 * name. A worktree's folder is the one case that can be built rather than found: its repo's path,
 * which a sibling usually knows, plus the worktree's name, which the marker leaves readable. That
 * name is best-effort (it went through the same lossy encoding) but it only labels the worktree;
 * the repo, and so the zone, is exact.
 *
 * Nothing found is an honest answer: `''` leaves the thread with no folder rather than a made-up
 * one, and the HUD greys out the folder buttons for it.
 */
function resolveProjectDir(name, known) {
  if (known.has(name)) return known.get(name)
  const mark = name.lastIndexOf(WORKTREE_MARK)
  if (mark > 0) {
    const root = known.get(name.slice(0, mark))
    if (root) {
      // Joined in the root's own separator, so the repo half comes back as exactly the string a
      // sibling reported — which is what the zone is keyed on.
      const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
      return [root, '.claude', 'worktrees', name.slice(mark + WORKTREE_MARK.length)].join(sep)
    }
  }
  return ''
}
```

**3e.** Replace

```js
  } catch {
    meta = readTranscriptMeta([])
  }
  metaCache.set(entry.id, { mtime: entry.mtime, meta })
  return meta
}
```

with

```js
  } catch {
    meta = readTranscriptMeta([])
  }
  // No cwd in a head shorter than the file is a head that ran out before the transcript said
  // where it was — not a transcript that never says.
  if (!meta.cwd && entry.size > HEAD_BYTES) meta = await openingMeta(entry)
  metaCache.set(entry.id, { mtime: entry.mtime, meta })
  return meta
}

/**
 * Metadata for a transcript whose first cwd lies past the head, read forward until it appears.
 *
 * `readHead` has to drop a trailing partial line, and a first record longer than the whole head
 * leaves it nothing at all — so the cwd, the start time and the first prompt went missing together,
 * and the thread fell through to guessing its folder from the folder's name.
 *
 * Everything up to the first cwd is written once and never changes, so once found it is kept
 * against the session alone. Keyed on mtime like the head, a live transcript with a giant first
 * record would re-read half a megabyte on every poll it moved.
 */
const openingCache = new Map()
async function openingMeta(entry) {
  const known = openingCache.get(entry.id)
  if (known) return known
  let meta
  try {
    meta = readTranscriptMeta(
      await readRecordsUntil(entry.file, { maxBytes: OPENING_BYTES, until: (r) => Boolean(r.cwd) })
    )
  } catch {
    meta = readTranscriptMeta([])
  }
  if (meta.cwd) openingCache.set(entry.id, meta)
  return meta
}
```

**3f.** In `scanThreads`, replace

```js
  const claimed = new Set()

  for (const s of desktop) {
```

with

```js
  const claimed = new Set()

  /**
   * Every path this machine has reported, keyed by the name the CLI would give its transcript
   * folder — what a transcript that never states its own cwd is resolved against. First report
   * wins, so two paths that happen to encode alike cannot trade places between polls.
   */
  const known = new Map()
  const learn = (p) => {
    if (typeof p !== 'string' || !p) return
    const name = encodeProjectDir(p)
    if (!known.has(name)) known.set(name, p)
  }

  for (const s of desktop) {
```

**3g.** Replace

```js
    const meta = entry ? await transcriptMeta(entry) : null

    add({
```

with

```js
    const meta = entry ? await transcriptMeta(entry) : null
    learn(s.cwd)
    learn(s.originCwd)
    learn(meta?.cwd)

    add({
```

**3h.** Replace

```js
  // Transcripts with no desktop record — usually threads started straight from the terminal.
  for (const [id, entry] of transcripts) {
    if (claimed.has(id)) continue
    const meta = await transcriptMeta(entry)
    const cwd = meta.cwd || decodeProjectDir(path.basename(entry.projectDir))
    const { projectPath, project, worktree } = projectOf(cwd, '')
```

with

```js
  // Transcripts with no desktop record — usually threads started straight from the terminal.
  // All of them are read first (cached, so free after the first poll), so that every path they
  // report is known before any one of them needs a folder resolved.
  const loose = []
  for (const [id, entry] of transcripts) {
    if (claimed.has(id)) continue
    const meta = await transcriptMeta(entry)
    learn(meta.cwd)
    loose.push({ id, entry, meta })
  }

  for (const { id, entry, meta } of loose) {
    const cwd = meta.cwd || resolveProjectDir(path.basename(entry.projectDir), known)
    const { projectPath, project, worktree } = projectOf(cwd, '')
```

- [ ] **Step 4: Run to verify pass.** `node --check server/harnesses/claude-code.mjs && node --test test/harness.test.mjs` → all PASS. `grep -n decodeProjectDir server/harnesses/claude-code.mjs` → no output.

- [ ] **Step 5: Commit.**

```bash
git add server/harnesses/claude-code.mjs test/harness.test.mjs
git commit -m "Find a transcript's cwd past its head, and never decode a folder name into one

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task H3: read the tail — real last activity, latest title, branch and worktree

**Files:**
- Modify: `server/harnesses/claude-code.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Consumes: `encodeProjectDir`, `resolveProjectDir`, `known`, `learn`, `loose` (H2); existing `TAIL_BYTES`, `readTail`.
- Produces: `readTranscriptTail(records) → { lastRecordAt, relocatedCwd, gitBranch, customTitle, aiTitle }`; `transcriptTail(entry)` (mtime-cached); `activityOf(entry, tail) → number`; `titleOf(meta, tail) → string`; `whereItRuns(dirName, meta, tail, known) → string`. In `scanThreads`: a `tail` local in the desktop loop, and `loose` items become `{ id, entry, meta, tail }`.

- [ ] **Step 1: Write the failing tests.** Append to `test/harness.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → the two new tests FAIL (`lastActivityAt` equals the file mtime; `cwd` is the repo root and `worktree` is `''`).

- [ ] **Step 3: Implement** in `server/harnesses/claude-code.mjs`.

**3a.** Replace (the end of `openingMeta`, from H2)

```js
  if (meta.cwd) openingCache.set(entry.id, meta)
  return meta
}
```

with

```js
  if (meta.cwd) openingCache.set(entry.id, meta)
  return meta
}

/**
 * What only the end of a transcript knows: when it last really did something, where it works
 * now, and what it is called now.
 *
 * "When it last did something" is its last *timestamped* record, not the file's mtime. The app
 * appends untimestamped bookkeeping — titles, modes, bridge and artifact records — to transcripts
 * in bulk, days or months after a conversation ended, and a colony reading mtime woke every one of
 * those threads from its three-day sleep at once.
 *
 * Later records win throughout: a thread renamed twice is called what it was renamed to last, and
 * a session that moved into a worktree is on the worktree's branch now, not the one it began on.
 */
function readTranscriptTail(records) {
  const tail = { lastRecordAt: 0, relocatedCwd: '', gitBranch: '', customTitle: '', aiTitle: '' }
  for (const r of records) {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (!Number.isNaN(t) && t > tail.lastRecordAt) tail.lastRecordAt = t
    if (typeof r.relocatedCwd === 'string' && r.relocatedCwd) tail.relocatedCwd = r.relocatedCwd
    if (r.gitBranch && r.gitBranch !== 'HEAD') tail.gitBranch = r.gitBranch
    if (r.customTitle) tail.customTitle = r.customTitle
    if (r.aiTitle) tail.aiTitle = r.aiTitle
  }
  return tail
}

/** The tail, like the head, is kept until the file changes. */
const tailCache = new Map()
async function transcriptTail(entry) {
  const cached = tailCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime) return cached.tail
  let tail
  try {
    tail = readTranscriptTail(jsonLines(await readTail(entry.file, TAIL_BYTES)))
  } catch {
    tail = readTranscriptTail([])
  }
  tailCache.set(entry.id, { mtime: entry.mtime, tail })
  return tail
}

/** When a transcript last did something: its last timestamped record, or its mtime if it has none. */
const activityOf = (entry, tail) => tail.lastRecordAt || entry.mtime

/** The CLI's own title precedence — custom, then AI, then summary, then first prompt — latest first. */
const titleOf = (meta, tail) =>
  tail?.customTitle || meta?.customTitle || tail?.aiTitle || meta?.aiTitle || meta?.summary || meta?.firstPrompt || ''

/**
 * Where a terminal thread works. Its transcript's folder is named after the cwd it lives in *now*
 * — a session that moves into a worktree has its transcript moved with it — so whichever cwd it
 * reported that encodes to that name wins over the one it happened to start in.
 */
function whereItRuns(dirName, meta, tail, known) {
  for (const cwd of [tail.relocatedCwd, meta.cwd]) {
    if (cwd && encodeProjectDir(cwd) === dirName) return cwd
  }
  return meta.cwd || resolveProjectDir(dirName, known)
}
```

**3b.** Replace

```js
    const meta = entry ? await transcriptMeta(entry) : null
    learn(s.cwd)
    learn(s.originCwd)
    learn(meta?.cwd)
```

with

```js
    const meta = entry ? await transcriptMeta(entry) : null
    const tail = entry ? await transcriptTail(entry) : null
    learn(s.cwd)
    learn(s.originCwd)
    learn(meta?.cwd)
    learn(tail?.relocatedCwd)
```

**3c.** Replace

```js
      title: s.title || meta?.customTitle || meta?.aiTitle || meta?.summary || meta?.firstPrompt || 'Untitled thread',
```

with

```js
      title: s.title || titleOf(meta, tail) || 'Untitled thread',
```

**3d.** Replace

```js
      gitBranch: meta?.gitBranch || '',
```

with

```js
      gitBranch: tail?.gitBranch || meta?.gitBranch || '',
```

**3e.** Replace

```js
        num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
        entry?.mtime || 0
      ),
```

with

```js
        num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
        entry ? activityOf(entry, tail) : 0
      ),
```

**3f.** Replace

```js
    const meta = await transcriptMeta(entry)
    learn(meta.cwd)
    loose.push({ id, entry, meta })
  }

  for (const { id, entry, meta } of loose) {
    const cwd = meta.cwd || resolveProjectDir(path.basename(entry.projectDir), known)
```

with

```js
    const meta = await transcriptMeta(entry)
    const tail = await transcriptTail(entry)
    learn(meta.cwd)
    learn(tail.relocatedCwd)
    loose.push({ id, entry, meta, tail })
  }

  for (const { id, entry, meta, tail } of loose) {
    const cwd = whereItRuns(path.basename(entry.projectDir), meta, tail, known)
```

**3g.** Replace `      titled: Boolean(meta.customTitle || meta.aiTitle),` with

```js
      titled: Boolean(tail.customTitle || meta.customTitle || tail.aiTitle || meta.aiTitle),
```

**3h.** Replace `      title: meta.customTitle || meta.aiTitle || meta.summary || meta.firstPrompt || 'Untitled thread',` with

```js
      title: titleOf(meta, tail) || 'Untitled thread',
```

**3i.** Replace `      gitBranch: meta.gitBranch,` with `      gitBranch: tail.gitBranch || meta.gitBranch,`

**3j.** Replace `      lastActivityAt: entry.mtime,` with `      lastActivityAt: activityOf(entry, tail),`

- [ ] **Step 4: Run to verify pass.** `node --check server/harnesses/claude-code.mjs && node --test test/harness.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/harnesses/claude-code.mjs test/harness.test.mjs
git commit -m "Date a thread by its last real record, and read its latest title, branch and worktree

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task H4: records from before focus was tracked are not "never opened"

**Files:**
- Modify: `server/harnesses/claude-code.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Produces: thread-internal field `hasFocusStamp: boolean` (stripped by `toThread`); constant `NEVER_FOCUSED_MS`.

- [ ] **Step 1: Write the failing test.** Append:

```js
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
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → FAIL: `old` is unread.

- [ ] **Step 3: Implement.**

**3a.** Replace

```js
const ACTIVE_WINDOW_MS = 30 * 60 * 1000
```

with

```js
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

/**
 * How long a desktop thread with no focus history counts as asking for you. Records the app wrote
 * before it kept `lastFocusedAt` have no such field, and reading its absence as "never opened" put a
 * `?` over every one of them — months of threads, all waving. Absent is unknowable, so only a
 * thread recent enough to plausibly be new is taken as unread on the strength of it: the same three
 * days after which an astronaut falls asleep anyway.
 */
const NEVER_FOCUSED_MS = 3 * 24 * 60 * 60 * 1000
```

**3b.** Replace `    lastFocusedAt: Math.max(existing.lastFocusedAt || 0, next.lastFocusedAt || 0),` with

```js
    lastFocusedAt: Math.max(existing.lastFocusedAt || 0, next.lastFocusedAt || 0),
    hasFocusStamp: existing.hasFocusStamp || next.hasFocusStamp,
```

**3c.** Replace

```js
    titled, hasLiveProcess, transcriptFile, recordActivityAt, ...rest
```

with

```js
    titled, hasLiveProcess, transcriptFile, recordActivityAt, hasFocusStamp, ...rest
```

**3d.** Replace `      lastFocusedAt: num(s.lastFocusedAt),` with

```js
      lastFocusedAt: num(s.lastFocusedAt),
      hasFocusStamp: 'lastFocusedAt' in s,
```

**3e.** Replace `      lastFocusedAt: 0,` with

```js
      lastFocusedAt: 0,
      hasFocusStamp: false,
```

**3f.** Replace

```js
  // Unread = the thread moved on after you last looked at it; never opened counts as unread.
  // Terminal-only threads have no focus history at all, so "unread" is unknowable — not true.
  for (const thread of threads) {
    const seenAt = thread.recordActivityAt ?? thread.lastActivityAt
    thread.unread = thread.desktopSessionIds.length > 0 && seenAt > thread.lastFocusedAt
```

with

```js
  // Unread = the thread moved on after you last looked at it; a recent thread never opened counts
  // as unread. Terminal-only threads have no focus history at all, so "unread" is unknowable — not
  // true.
  for (const thread of threads) {
    const seenAt = thread.recordActivityAt ?? thread.lastActivityAt
    const moved = thread.hasFocusStamp ? seenAt > thread.lastFocusedAt : now - seenAt < NEVER_FOCUSED_MS
    thread.unread = thread.desktopSessionIds.length > 0 && moved
```

- [ ] **Step 4: Run to verify pass.** `node --test test/harness.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/harnesses/claude-code.mjs test/harness.test.mjs
git commit -m "Do not read a record from before focus tracking as a thread never opened

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task H5: fold the copies the desktop app leaves behind

**Files:**
- Modify: `server/harnesses/claude-code.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Consumes: `readTranscriptTail`, `activityOf`, the H3 desktop-loop `lastActivityAt` block, `loose` items `{ id, entry, meta, tail }`.
- Produces: `meta.rootUuid`, `tail.endsInSession`; constant `SAME_MOMENT_MS`; `supersededBy(id, entry, meta, tail, transcripts, rootOwners) → string`; `rootOwners: Map<rootUuid, { id, createdAt, lastActivityAt }[]>` and a `lastActivityAt` local in the desktop loop.

- [ ] **Step 1: Write the failing tests.** Append:

```js
test("a copy of a desktop thread's transcript is that thread, not a second astronaut", async () => {
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
    await writeTranscript(h, cwd, copy, [...convo, { type: 'custom-title', customTitle: 'copy', sessionId: copy }])
    await writeDesktopRecord(h, {
      sessionId: desktopId(), cliSessionId: sid, cwd, title: 'the thread',
      createdAt: Date.now() - 2 * HOUR, lastActivityAt: Date.now() - 2 * HOUR, lastFocusedAt: Date.now(),
    })
    assert.deepEqual((await h.scanThreads()).map((t) => t.id), [`claude-code:${sid}`])
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
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → both FAIL (the copy and the original each appear as extra threads).

- [ ] **Step 3: Implement.**

**3a.** Replace

```js
  const meta = { customTitle: '', aiTitle: '', summary: '', firstPrompt: '', cwd: '', gitBranch: '', startedAt: 0 }
```

with

```js
  const meta = {
    customTitle: '', aiTitle: '', summary: '', firstPrompt: '', cwd: '', gitBranch: '', startedAt: 0, rootUuid: '',
  }
```

**3b.** Replace

```js
      if (text && !text.startsWith('<')) meta.firstPrompt = text.slice(0, PROMPT_CHARS)
    }
  }
  return meta
}
```

with

```js
      if (text && !text.startsWith('<')) meta.firstPrompt = text.slice(0, PROMPT_CHARS)
    }
    // The conversation's first message, by its own id. A transcript the desktop app copied or
    // imported keeps the ids of the records it copied, so two files sharing this share a conversation.
    if (!meta.rootUuid && r.type === 'user' && typeof r.uuid === 'string' && r.parentUuid == null) {
      meta.rootUuid = r.uuid
    }
  }
  return meta
}
```

**3c.** Replace

```js
  const tail = { lastRecordAt: 0, relocatedCwd: '', gitBranch: '', customTitle: '', aiTitle: '' }
  for (const r of records) {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (!Number.isNaN(t) && t > tail.lastRecordAt) tail.lastRecordAt = t
    if (typeof r.relocatedCwd === 'string' && r.relocatedCwd) tail.relocatedCwd = r.relocatedCwd
    if (r.gitBranch && r.gitBranch !== 'HEAD') tail.gitBranch = r.gitBranch
    if (r.customTitle) tail.customTitle = r.customTitle
    if (r.aiTitle) tail.aiTitle = r.aiTitle
  }
  return tail
```

with

```js
  const tail = {
    lastRecordAt: 0, relocatedCwd: '', gitBranch: '', customTitle: '', aiTitle: '', endsInSession: '',
  }
  for (const r of records) {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (!Number.isNaN(t) && t > tail.lastRecordAt) tail.lastRecordAt = t
    if (typeof r.relocatedCwd === 'string' && r.relocatedCwd) tail.relocatedCwd = r.relocatedCwd
    if (r.gitBranch && r.gitBranch !== 'HEAD') tail.gitBranch = r.gitBranch
    if (r.customTitle) tail.customTitle = r.customTitle
    if (r.aiTitle) tail.aiTitle = r.aiTitle
    // Whose conversation the file ends in. A copy keeps the session ids of the records it copied.
    if ((r.type === 'user' || r.type === 'assistant') && typeof r.sessionId === 'string') {
      tail.endsInSession = r.sessionId
    }
  }
  return tail
```

**3d.** Replace `const NEVER_FOCUSED_MS = 3 * 24 * 60 * 60 * 1000` with

```js
const NEVER_FOCUSED_MS = 3 * 24 * 60 * 60 * 1000

/** How close a desktop thread's creation and a transcript's first record must be to be one event. */
const SAME_MOMENT_MS = 60 * 1000
```

**3e.** Replace `async function scanThreads() {` with

```js
/**
 * The thread a terminal-only transcript is really a copy of, or `''`.
 *
 * Importing or forking in the desktop app writes a fresh transcript under a new session id and
 * leaves the source file behind, and nothing links the two. Left alone each becomes an astronaut:
 * the same conversation, twice, on the same plot. Two shapes are folded, both conservatively:
 *
 *   - **A copy.** Its conversation ends in another session's records — the ids came along with the
 *     history — and that session's transcript is on disk. It is that thread.
 *   - **A superseded original.** It began the conversation a desktop thread was opened on, at the
 *     moment that thread was created, and wrote nothing after that thread last did. Whatever it
 *     holds beyond the copy is a turn somebody rewound, not a thread anybody is working in.
 *
 * A transcript that did anything after its would-be owner is a continuation, and stays.
 */
function supersededBy(id, entry, meta, tail, transcripts, rootOwners) {
  const other = tail.endsInSession
  if (other && other !== id && transcripts.has(other)) return ID(other)
  for (const owner of rootOwners.get(meta.rootUuid) || []) {
    const sameMoment = Math.abs(owner.createdAt - meta.startedAt) <= SAME_MOMENT_MS
    if (sameMoment && activityOf(entry, tail) <= owner.lastActivityAt) return owner.id
  }
  return ''
}

async function scanThreads() {
```

**3f.** Replace

```js
    if (!known.has(name)) known.set(name, p)
  }
```

with

```js
    if (!known.has(name)) known.set(name, p)
  }
  /** Which desktop thread began each conversation — the one the app opened on it, never a fork. */
  const rootOwners = new Map()
```

**3g.** Replace

```js
    learn(tail?.relocatedCwd)

    add({
```

with

```js
    learn(tail?.relocatedCwd)

    // The desktop record's own stamp lags: the app writes it when the thread is focused, so a
    // session running in a terminal — or in a window you are not looking at — reads as hours
    // old while its transcript is being written to right now. The later of the two is true.
    const lastActivityAt = Math.max(
      num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
      entry ? activityOf(entry, tail) : 0
    )
    if (meta?.rootUuid && !s.forkedFromSessionId) {
      const owners = rootOwners.get(meta.rootUuid) || []
      owners.push({ id: ID(cliSessionId || s.sessionId), createdAt: num(s.createdAt), lastActivityAt })
      rootOwners.set(meta.rootUuid, owners)
    }

    add({
```

**3h.** Replace

```js
      // The desktop record's own stamp lags: the app writes it when the thread is focused, so a
      // session running in a terminal — or in a window you are not looking at — reads as hours
      // old while its transcript is being written to right now. The later of the two is true.
      lastActivityAt: Math.max(
        num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
        entry ? activityOf(entry, tail) : 0
      ),
```

with

```js
      lastActivityAt,
```

**3i.** Replace

```js
  for (const { id, entry, meta, tail } of loose) {
    const cwd = whereItRuns(path.basename(entry.projectDir), meta, tail, known)
```

with

```js
  for (const { id, entry, meta, tail } of loose) {
    if (supersededBy(id, entry, meta, tail, transcripts, rootOwners)) continue
    const cwd = whereItRuns(path.basename(entry.projectDir), meta, tail, known)
```

- [ ] **Step 4: Run to verify pass.** `node --test test/harness.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/harnesses/claude-code.mjs test/harness.test.mjs
git commit -m "Fold the transcript copies the desktop app leaves behind into the thread they belong to

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task H6: a live thread whose subagents are working is working; EPERM is alive

**Files:**
- Modify: `server/harnesses/claude-code.mjs`
- Test: `test/harness.test.mjs`

**Interfaces:**
- Consumes: `readTranscriptTail` (H5 form), the H4 unread loop.
- Produces: `tail.handedBack`, `tail.handedBackAt`; thread-internal `handedBack`, `handedBackAt` (stripped by `toThread`); `BACKGROUND_WINDOW_MS`; `newestSubagentWrite(transcriptFile, sessionId) → Promise<number>`. Removes `awaitingReply`.

- [ ] **Step 1: Write the failing tests.** Append:

```js
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
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → all three FAIL.

- [ ] **Step 3: Implement.**

**3a.** Delete the whole `awaitingReply` block — replace

```js
/**
 * Whether a transcript ends with the turn handed back to you.
 *
 * A live process is not the same thing as work in progress. The CLI holds its process open while
 * it sits at the prompt, so "the pid exists and the file moved recently" marks a thread that
 * finished four minutes ago and asked you a question as *working* — an astronaut hammering away
 * at a thread whose whole point is that it is waiting.
 *
 * The transcript says which it is. A last assistant message that called a tool is mid-turn; one
 * that called nothing has handed the turn back and the reply is yours. `stop_reason` alone will
 * not do — it is `end_turn` on a main thread's last message and empty on some others — so what
 * the message *called* is the half worth testing.
 *
 * Only threads that could plausibly be running pay for this, so it costs one small read each.
 */
async function awaitingReply(file) {
  let records
  try {
    records = jsonLines(await readTail(file, TAIL_BYTES))
  } catch {
    return false
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    // A user turn, a tool result or an attachment all mean the model speaks next — whatever the
    // process is doing, it is not waiting on anyone.
    if (r.type === 'user') return false
    if (r.type !== 'assistant') continue
    const content = r.message?.content
    const calling = Array.isArray(content) && content.some((c) => c?.type === 'tool_use')
    return !calling && r.message?.stop_reason !== 'tool_use'
  }
  return false
}

```

with nothing (an empty string). Leave the `TAIL_BYTES` line above it in place.

**3b.** Replace the whole body of `readTranscriptTail` as H5 left it:

```js
  const tail = {
    lastRecordAt: 0, relocatedCwd: '', gitBranch: '', customTitle: '', aiTitle: '', endsInSession: '',
  }
  for (const r of records) {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (!Number.isNaN(t) && t > tail.lastRecordAt) tail.lastRecordAt = t
    if (typeof r.relocatedCwd === 'string' && r.relocatedCwd) tail.relocatedCwd = r.relocatedCwd
    if (r.gitBranch && r.gitBranch !== 'HEAD') tail.gitBranch = r.gitBranch
    if (r.customTitle) tail.customTitle = r.customTitle
    if (r.aiTitle) tail.aiTitle = r.aiTitle
    // Whose conversation the file ends in. A copy keeps the session ids of the records it copied.
    if ((r.type === 'user' || r.type === 'assistant') && typeof r.sessionId === 'string') {
      tail.endsInSession = r.sessionId
    }
  }
  return tail
```

with

```js
  const tail = {
    lastRecordAt: 0, relocatedCwd: '', gitBranch: '', customTitle: '', aiTitle: '', endsInSession: '',
    handedBack: false, handedBackAt: 0,
  }
  let turn = null
  for (const r of records) {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (!Number.isNaN(t) && t > tail.lastRecordAt) tail.lastRecordAt = t
    if (typeof r.relocatedCwd === 'string' && r.relocatedCwd) tail.relocatedCwd = r.relocatedCwd
    if (r.gitBranch && r.gitBranch !== 'HEAD') tail.gitBranch = r.gitBranch
    if (r.customTitle) tail.customTitle = r.customTitle
    if (r.aiTitle) tail.aiTitle = r.aiTitle
    if (r.type === 'user' || r.type === 'assistant') {
      turn = r
      // Whose conversation the file ends in. A copy keeps the session ids of the records it copied.
      if (typeof r.sessionId === 'string') tail.endsInSession = r.sessionId
    }
  }
  /*
   * Whose turn it is. A live process is not work in progress: the CLI holds its process open while
   * it sits at the prompt, so "the pid exists and the file moved recently" marks a thread that
   * finished four minutes ago and asked you a question as *working*.
   *
   * The last user or assistant record says which. A user record — a prompt or a tool result — means
   * the model speaks next. An assistant message that called a tool is mid-turn; one that called
   * nothing has handed the turn back, and the reply is yours. `stop_reason` alone will not do — it is
   * `end_turn` on a main thread's last message and empty on some others — so what the message
   * *called* is the half worth testing. Bookkeeping written after a turn ends (hook attachments,
   * titles) says nothing either way, which is why only those two types count.
   */
  if (turn?.type === 'assistant') {
    const content = turn.message?.content
    const calling = Array.isArray(content) && content.some((c) => c?.type === 'tool_use')
    if (!calling && turn.message?.stop_reason !== 'tool_use') {
      tail.handedBack = true
      tail.handedBackAt = Date.parse(turn.timestamp) || 0
    }
  }
  return tail
```

**3c.** Replace

```js
    } catch {
      /* process is gone */
    }
```

with

```js
    } catch (err) {
      // EPERM is a process that exists but is not ours to signal — alive. Only ESRCH means gone. A
      // pid recycled by somebody else's process reads as alive too, which is why being live is never
      // enough to count as working: the transcript has to have moved as well.
      if (err.code === 'EPERM') live.add(record.sessionId)
    }
```

**3d.** Replace `const SAME_MOMENT_MS = 60 * 1000` with

```js
const SAME_MOMENT_MS = 60 * 1000

/**
 * How recently a session's subagents must have written for the session to count as working. A
 * thread that handed the turn back while a background agent or workflow it started carries on has a
 * quiet transcript — and a busy folder beside it.
 */
const BACKGROUND_WINDOW_MS = 2 * 60 * 1000
```

**3e.** Replace `/** Every thread the desktop app has a record for. */` with

```js
/** The newest write anywhere under a session's subagent folder, `<project>/<session>/subagents/**`. */
async function newestSubagentWrite(transcriptFile, sessionId) {
  let entries
  try {
    entries = await fsp.readdir(path.join(path.dirname(transcriptFile), sessionId, 'subagents'), {
      recursive: true,
      withFileTypes: true,
    })
  } catch {
    return 0
  }
  let newest = 0
  for (const e of entries) {
    if (!e.isFile()) continue
    try {
      const { mtimeMs } = await fsp.stat(path.join(e.parentPath, e.name))
      if (mtimeMs > newest) newest = mtimeMs
    } catch {
      /* written and gone between the listing and the stat */
    }
  }
  return newest
}

/** Every thread the desktop app has a record for. */
```

**3f.** Replace `    hasLiveProcess: existing.hasLiveProcess || next.hasLiveProcess,` (in `mergeThread`) with

```js
    hasLiveProcess: existing.hasLiveProcess || next.hasLiveProcess,
    handedBack: existing.handedBack || next.handedBack,
    handedBackAt: Math.max(existing.handedBackAt || 0, next.handedBackAt || 0),
```

**3g.** Replace

```js
    titled, hasLiveProcess, transcriptFile, recordActivityAt, hasFocusStamp, ...rest
```

with

```js
    titled, hasLiveProcess, transcriptFile, recordActivityAt, hasFocusStamp, handedBack, handedBackAt, ...rest
```

**3h.** Replace `      hasLiveProcess: live.has(cliSessionId),` with

```js
      hasLiveProcess: live.has(cliSessionId),
      handedBack: tail?.handedBack || false,
      handedBackAt: tail?.handedBackAt || 0,
```

**3i.** Replace `      hasLiveProcess: live.has(id),` with

```js
      hasLiveProcess: live.has(id),
      handedBack: tail.handedBack,
      handedBackAt: tail.handedBackAt,
```

**3j.** Replace

```js
    thread.unread = thread.desktopSessionIds.length > 0 && moved
    const fresh = now - thread.lastActivityAt < ACTIVE_WINDOW_MS
    const waiting =
      thread.hasLiveProcess && fresh && thread.transcriptFile ? await awaitingReply(thread.transcriptFile) : false
    thread.running = thread.hasLiveProcess && fresh && !waiting
    // A thread that handed the turn back wants you, whether or not the desktop app has ever seen
    // it — the only way a terminal-only thread can ask for anything at all.
    if (waiting) thread.unread = true
```

with

```js
    thread.unread = thread.desktopSessionIds.length > 0 && moved
    const subagentAt =
      thread.hasLiveProcess && thread.transcriptFile
        ? await newestSubagentWrite(thread.transcriptFile, thread.cliSessionId)
        : 0
    const fresh = now - Math.max(thread.lastActivityAt, subagentAt) < ACTIVE_WINDOW_MS
    const background = now - subagentAt < BACKGROUND_WINDOW_MS
    const waiting = thread.hasLiveProcess && fresh && thread.handedBack
    thread.running = thread.hasLiveProcess && (background || (fresh && !waiting))
    // A thread that handed the turn back wants you, whether or not the desktop app has ever seen
    // it — the only way a terminal-only thread can ask for anything at all. Unless you have looked
    // at it since: the desktop app records that, and looking is the answer to "is it waiting?".
    const lookedSince = thread.handedBackAt > 0 && thread.lastFocusedAt >= thread.handedBackAt
    if (waiting && !lookedSince) thread.unread = true
```

- [ ] **Step 4: Run to verify pass.** `node --check server/harnesses/claude-code.mjs && node --test test/harness.test.mjs` → all PASS. `grep -n awaitingReply server/harnesses/claude-code.mjs` → no output.

- [ ] **Step 5: Commit.**

```bash
git add server/harnesses/claude-code.mjs test/harness.test.mjs
git commit -m "Count a live thread's subagents as its work, and a process we cannot signal as alive

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task H7: new-session links encode spaces the way the apps' own quick actions do

**Files:**
- Modify: `server/harnesses/claude-code.mjs` (`newSession`), `server/harnesses/codex.mjs` (`newSession`)
- Test: `test/harness.test.mjs`

- [ ] **Step 1: Write the failing test.** Append:

```js
test("a new conversation's folder is %-encoded, the way the app's own Finder quick action sends it", async () => {
  // URLSearchParams form-encodes a space as `+`, which a handler decoding with decodeURIComponent
  // reads as a literal plus — a folder that does not exist. %20 reads the same under either parser.
  const { url } = await claudeCode.newSession('/tmp/Claude code ')
  assert.equal(url, 'claude://code/new?folder=%2Ftmp%2FClaude%20code%20')
  assert.equal(new URL(url).searchParams.get('folder'), '/tmp/Claude code ')
  assert.equal(decodeURIComponent(url.split('folder=')[1]), '/tmp/Claude code ')
  assert.equal(codex.newSession('/tmp/some repo').url, 'codex://threads/new?path=%2Ftmp%2Fsome%20repo')
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/harness.test.mjs` → FAIL (`…Claude+code+`).

- [ ] **Step 3: Implement.** In `server/harnesses/claude-code.mjs`, replace

```js
  const url = `claude://code/new?${new URLSearchParams({ folder: dir })}`
```

with

```js
  // encodeURIComponent, not URLSearchParams: the quick action sends `%20`, and `+` only means a
  // space to a form parser — a handler that decodes with decodeURIComponent reads a literal plus.
  const url = `claude://code/new?folder=${encodeURIComponent(dir)}`
```

In `server/harnesses/codex.mjs`, replace

```js
  return { ok: true, url: `codex://threads/new?${new URLSearchParams({ path: dir })}` }
```

with

```js
  // %20 for a space, not a form-encoded `+`: it reads the same whichever way the app decodes it.
  return { ok: true, url: `codex://threads/new?path=${encodeURIComponent(dir)}` }
```

- [ ] **Step 4: Run to verify pass.** `node --test test/harness.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/harnesses/claude-code.mjs server/harnesses/codex.mjs test/harness.test.mjs
git commit -m "Percent-encode the folder in new-session links, as the apps' own quick actions do

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# Track S — server (`.worktrees/server`, branch `fix/server`)

### Task S1: in-process request helper; Origin must match Host exactly

**Files:**
- Create: `test/support/inject.mjs`, `test/api.test.mjs`
- Modify: `server/api.mjs`, `test/state.test.mjs` (one line — see Step 4d)

**Interfaces:**
- Produces: `inject(handler, { method, url, headers, body }) → Promise<{ status, headers, text, json }>` (`status` 0 if the handler called `next` without answering; rejects if the handler's promise rejects). In `api.mjs`: `export function isLocalHost(req) → boolean`; private `sameServer(origin, host)`, `LOOPBACK`. Test helpers in `api.test.mjs`: `scratch(label)`, `apiWith(dataDir)`, `call(api, method, url, { headers, body })`, `HOST`.

- [ ] **Step 1: Create the helper** `test/support/inject.mjs` (not a test file — the runner only picks up `*.test.mjs`):

```js
/**
 * A request, driven through a Connect-style handler with no socket underneath it.
 *
 * A real `http.IncomingMessage` and `ServerResponse` run over an in-memory duplex, so the handler
 * sees exactly what a server would give it — headers, a readable body, a response it can stream —
 * and the bytes it writes come back parsed. Nothing binds a port, which keeps the tests that use
 * this runnable where a loopback listener is not allowed: sandboxes, locked-down CI containers.
 *
 * Resolves with `{ status, headers, text, json }`, where `status` is 0 if the handler passed the
 * request on (called `next`) without answering it. Rejects if the handler's own promise rejects —
 * which in a real server is a crash, and exactly what a test wants to see.
 */
import http from 'node:http'
import { Duplex } from 'node:stream'

export function inject(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const written = []
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        written.push(Buffer.from(chunk))
        done()
      },
    })
    socket.remoteAddress = '127.0.0.1'

    const req = new http.IncomingMessage(socket)
    req.method = method
    req.url = url
    req.httpVersion = '1.1'
    req.httpVersionMajor = 1
    req.httpVersionMinor = 1
    req.headers = {}
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) req.headers[k.toLowerCase()] = v
    if (body !== undefined) req.push(typeof body === 'string' ? body : JSON.stringify(body))
    req.push(null)

    const res = new http.ServerResponse(req)
    res.assignSocket(socket)
    let settled = false
    const settle = (passedOn) => {
      if (settled) return
      settled = true
      resolve(passedOn ? { status: 0, headers: {}, text: '', json: undefined } : parse(Buffer.concat(written)))
    }
    res.on('finish', () => setImmediate(() => settle(false)))
    Promise.resolve()
      .then(() => handler(req, res, () => settle(true)))
      .catch((err) => {
        settled = true
        reject(err)
      })
  })
}

function parse(raw) {
  const split = raw.indexOf('\r\n\r\n')
  const head = raw.subarray(0, split).toString('latin1').split('\r\n')
  const headers = {}
  for (const line of head.slice(1)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  let body = raw.subarray(split + 4)
  if (/chunked/i.test(headers['transfer-encoding'] || '')) body = unchunk(body)
  const text = body.toString('utf8')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: Number(head[0].split(' ')[1]), headers, text, json }
}

/** Undo HTTP/1.1 chunked framing: `<hex length>\r\n<bytes>\r\n`, ending at a zero-length chunk. */
function unchunk(buf) {
  const parts = []
  let pos = 0
  for (;;) {
    const eol = buf.indexOf('\r\n', pos)
    if (eol === -1) break
    const size = parseInt(buf.subarray(pos, eol).toString('latin1'), 16)
    if (!size) break
    parts.push(buf.subarray(eol + 2, eol + 2 + size))
    pos = eol + 2 + size + 2
  }
  return Buffer.concat(parts)
}
```

- [ ] **Step 2: Write the failing tests.** Create `test/api.test.mjs`:

```js
/**
 * The API's edges — who may call it, what it will act on, and what it does when the disk
 * misbehaves — driven in-process through `support/inject.mjs`, so no port is ever bound.
 *
 * The harness scan is pointed at an empty home before the API is first imported, so nothing in this
 * file reads the machine it runs on. Each test gets its own data folder through a fresh,
 * cache-busted import, because the API reads BOT_CROSSING_DATA once, at import.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inject } from './support/inject.mjs'

const scratch = (label) => fsp.mkdtemp(path.join(os.tmpdir(), `bot-crossing-${label}-`))

const EMPTY_HOME = await scratch('home')
process.env.HOME = EMPTY_HOME
process.env.USERPROFILE = EMPTY_HOME
process.env.APPDATA = path.join(EMPTY_HOME, 'AppData', 'Roaming')
process.env.LOCALAPPDATA = path.join(EMPTY_HOME, 'AppData', 'Local')
process.env.XDG_CONFIG_HOME = path.join(EMPTY_HOME, '.config')
delete process.env.CODEX_HOME
delete process.env.BOT_CROSSING_CURSOR_PROJECTS
delete process.env.BOT_CROSSING_HOST

async function apiWith(dataDir) {
  process.env.BOT_CROSSING_DATA = dataDir
  const { apiMiddleware } = await import(`../server/api.mjs?${dataDir}`)
  return apiMiddleware
}

const HOST = 'localhost:5274'

/** A request as the colony's own page sends it; any header can be overridden, or removed with undefined. */
const call = (api, method, url, { headers = {}, body } = {}) =>
  inject(api, {
    method,
    url,
    headers: { host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', ...headers },
    body,
  })

// ── who may call it ───────────────────────────────────────────────────────────

test('another page on this machine, on another port, can neither read nor write the colony', async () => {
  const api = await apiWith(await scratch('data'))
  assert.equal((await call(api, 'GET', '/api/state', { headers: { origin: 'http://localhost:3000' } })).status, 403)
  const put = await call(api, 'PUT', '/api/state', {
    headers: { origin: 'http://127.0.0.1:8080' },
    body: { archived: ['x'] },
  })
  assert.equal(put.status, 403)
})

test('a request the browser marks as same-site is refused, even with no Origin on it', async () => {
  const api = await apiWith(await scratch('data'))
  const res = await call(api, 'GET', '/api/state', { headers: { origin: undefined, 'sec-fetch-site': 'same-site' } })
  assert.equal(res.status, 403)
})

test("the page's own origin still gets through, however loopback is spelt", async () => {
  const api = await apiWith(await scratch('data'))
  for (const host of ['localhost:5274', '127.0.0.1:5274', '[::1]:5274']) {
    const res = await call(api, 'GET', '/api/state', {
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' },
    })
    assert.equal(res.status, 200, host)
  }
})

test("this machine's LAN address is not trusted unless the colony was served to the network", async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)
  if (!lan) return t.skip('no LAN address on this machine')
  const api = await apiWith(await scratch('data'))
  const host = `${lan.address}:5274`
  assert.equal((await call(api, 'GET', '/api/state', { headers: { host, origin: `http://${host}` } })).status, 403)
})
```

- [ ] **Step 3: Run to verify failure.** `node --test test/api.test.mjs` → the cross-port, same-site and LAN tests FAIL (200 instead of 403); the own-origin test PASSES.

- [ ] **Step 4: Implement** in `server/api.mjs`.

**4a.** Replace

```js
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// The machine's own LAN addresses count as local too, so the colony can be
// served to the home network with BOT_CROSSING_HOST set. Harmless when bound
// to loopback (those hosts can't reach the server anyway), and the Host +
// Origin pairing still stops DNS rebinding and CSRF exactly as before.
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
  }
}
```

with

```js
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])
const LOCAL_HOSTS = new Set(LOOPBACK)

/**
 * The machine's own LAN addresses count as local only when the colony has been served to the
 * network on purpose, with BOT_CROSSING_HOST. Trusted unconditionally, they let a page served from
 * this machine's LAN address — on any port, by anything — pass as this server's own page.
 */
const BIND = process.env.BOT_CROSSING_HOST || ''
if (BIND && !LOOPBACK.has(hostnameOf(BIND))) {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
    }
  }
}
```

**4b.** Replace

```js
 *   - **Origin** stops CSRF. A cross-site `fetch` with a `text/plain` body is not
 *     preflighted, so without this check any page you happened to be visiting could POST
 *     here — spawning sessions, opening Finder windows, or wiping the colony layout —
 *     even though it could never read the reply.
```

with

```js
 *   - **Origin** stops CSRF. A cross-site `fetch` with a `text/plain` body is not
 *     preflighted, so without this check any page you happened to be visiting could POST
 *     here — spawning sessions, opening Finder windows, or wiping the colony layout —
 *     even though it could never read the reply. It must name this server exactly, port
 *     included: every other page on localhost shares its hostname.
```

**4c.** Replace

```js
function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false

  const origin = req.headers.origin
  if (origin && origin !== 'null') return LOCAL_HOSTS.has(hostnameOf(origin))
  return req.method === 'GET' || req.method === 'HEAD'
}
```

with

```js
function isLocalRequest(req) {
  if (!isLocalHost(req)) return false

  // The browser says outright where a request came from. `same-site` is the one that matters:
  // another page on localhost, on any other port, is the same *site* as this one — so it passed a
  // hostname check, and could read every thread on the machine.
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false

  const origin = req.headers.origin
  if (origin && origin !== 'null') return sameServer(origin, req.headers.host)
  return req.method === 'GET' || req.method === 'HEAD'
}

/** Whether a request's Host is one this server answers to — the DNS-rebinding half of the check. */
export function isLocalHost(req) {
  return LOCAL_HOSTS.has(hostnameOf(req.headers.host))
}

/** Origin and Host name the same server, down to the port. */
function sameServer(origin, host) {
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}
```

**4d.** The existing socket tests connect to `127.0.0.1` but claim `Origin: http://localhost:<port>` — a
different server under the exact rule, so every PUT there would now be refused. In `test/state.test.mjs`
(inside `withServer`), replace

```js
      headers: { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json' },
```

with

```js
      headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
```

Do **not** run `test/state.test.mjs` (it binds sockets); the orchestrator runs it.

- [ ] **Step 5: Run to verify pass.** `node --test test/api.test.mjs` → all PASS.

- [ ] **Step 6: Commit.**

```bash
git add server/api.mjs test/support/inject.mjs test/api.test.mjs test/state.test.mjs
git commit -m "Answer only an Origin that names this exact server, port included

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task S2: close what the Vite dev server itself exposes

**Files:**
- Modify: `vite.config.js` (full replacement below)
- Create: `test/vite.test.mjs`

**Interfaces:**
- Consumes: `inject` (S1).

- [ ] **Step 1: Write the failing tests.** Create `test/vite.test.mjs`:

```js
/**
 * The dev server's own surface, beyond /api: what Vite itself will serve, and which of its own
 * routes answer. Driven in-process through Vite's middleware stack — no port is bound, and the
 * config is loaded natively, so nothing is written next to it.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { inject } from './support/inject.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-vite-'))
// The config pulls the API in: point its state at scratch space and its scan at an empty home first.
process.env.BOT_CROSSING_DATA = scratch
process.env.HOME = scratch
process.env.USERPROFILE = scratch
// If the editor route were ever reachable, this is what it would launch: nothing at all.
process.env.LAUNCH_EDITOR = '/usr/bin/true'

const server = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  configLoader: 'native',
  cacheDir: path.join(scratch, '.vite'),
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
})
after(() => server.close())

const HOST = 'localhost:5274'
const get = (url, headers = {}) => inject(server.middlewares, { url, headers: { host: HOST, ...headers } })
/** `/@fs/…` for a file inside the repo, each segment escaped — the repo path may hold spaces. */
const fsUrl = (...parts) => '/@fs' + path.join(root, ...parts).split(path.sep).map(encodeURIComponent).join('/')

test('the dev server will not hand out the colony file or anything under .claude', { skip: process.platform === 'win32' }, async () => {
  assert.equal((await get('/.claude/launch.json')).status, 403)
  assert.equal((await get(fsUrl('.claude', 'launch.json'))).status, 403)
  assert.equal((await get(fsUrl('data', 'colony.json'))).status, 403)
})

test('the app itself is still served', async () => {
  assert.equal((await get('/index.html')).status, 200)
})

test("Vite's open-in-editor route is closed", { skip: process.platform === 'win32' }, async () => {
  assert.equal((await get('/__open-in-editor?file=package.json')).status, 404)
})

test('no reply grants CORS to another local origin', async () => {
  const read = await get('/api/state', { origin: 'http://localhost:3000' })
  assert.equal(read.headers['access-control-allow-origin'], undefined)
  const preflight = await inject(server.middlewares, {
    method: 'OPTIONS',
    url: '/api/state',
    headers: { host: HOST, origin: 'http://localhost:3000', 'access-control-request-method': 'PUT' },
  })
  assert.equal(preflight.headers['access-control-allow-origin'], undefined)
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/vite.test.mjs` → the `.claude`/colony test FAILs (200s), the editor test FAILs (200), the CORS test FAILs (ACAO echoes the origin). The index test PASSes.

- [ ] **Step 3: Implement.** Replace the whole of `vite.config.js` with:

```js
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    // Vite's own "open this file in your editor" route answers any GET, and a cross-site <img> can
    // send one. Nothing here uses it. Plugin middleware runs before Vite's, so this is the answer.
    server.middlewares.use('/__open-in-editor', (_req, res) => {
      res.statusCode = 404
      res.end()
    })
    // Connect ignores the promise a handler returns; hand a rejection to Vite's error page rather
    // than letting it take the process down.
    server.middlewares.use((req, res, next) => {
      apiMiddleware(req, res, next).catch(next)
    })
  },
})

export default defineConfig({
  plugins: [api()],
  server: {
    // PORT lets a second copy run alongside the first without a flag on the command line.
    port: Number(process.env.PORT) || 5274,
    strictPort: false,
    // The page and its API are one origin, so nothing needs CORS — and Vite's default reflects any
    // localhost origin onto every reply, /api included, which let another local page read them.
    cors: false,
    fs: {
      strict: true,
      allow: [root],
      // Replaces Vite's defaults rather than adding to them, so those are restated first. A pattern
      // containing a slash is matched against the absolute path, hence the leading globstar.
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/colony.json*', '**/.claude/**'],
    },
  },
  build: { target: 'esnext' },
})
```

- [ ] **Step 4: Run to verify pass.** `node --test test/vite.test.mjs` → all PASS, and the process exits on its own. (If it hangs after the tests pass, report that — do not add `process.exit`.) `node --test test/api.test.mjs` → still all PASS.

- [ ] **Step 5: Commit.**

```bash
git add vite.config.js test/vite.test.mjs
git commit -m "Close Vite's CORS, its editor route, and the repo files it would serve

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task S3: reveal and new session act only on folders a thread named

**Files:**
- Modify: `server/api.mjs`
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: `scanThreads` (existing import in `api.mjs`), `call`, `apiWith`, `scratch` (S1).
- Produces: private `knownFolders`, `learnFolders(threads)`, `isKnownFolder(dir) → Promise<boolean>`. Test helper `fakeOpener() → { opened() }`.

- [ ] **Step 1: Write the failing test.** In `test/api.test.mjs` add to the imports:

```js
import { setTimeout as delay } from 'node:timers/promises'
```

and append:

```js
// ── what it will act on ───────────────────────────────────────────────────────

/**
 * Stand-ins for `open` / `xdg-open`, first on PATH, that only write down what they were asked to
 * open. A test that expects nothing to launch can then prove it — and one that fails on the way to
 * that proof opens nothing on the machine running it.
 */
async function fakeOpener() {
  const bin = await scratch('bin')
  const log = path.join(bin, 'opened.log')
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`
  for (const name of ['open', 'xdg-open']) await fsp.writeFile(path.join(bin, name), script, { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  return { opened: async () => (await fsp.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) }
}

test('reveal and new session refuse a folder no thread ever ran in', { skip: process.platform === 'win32' }, async () => {
  const opener = await fakeOpener()
  const api = await apiWith(await scratch('data'))
  const stranger = await scratch('stranger') // exists, is a directory, and no thread ever ran in it
  const bundle = path.join(stranger, 'Calculator.app') // `open` launches one of these
  await fsp.mkdir(bundle)
  for (const url of ['/api/reveal', '/api/new-session']) {
    for (const folder of [stranger, bundle]) {
      const res = await call(api, 'POST', url, { body: { folder, harness: 'claude-code' } })
      assert.equal(res.status, 400, `${url} ${folder}`)
    }
  }
  await delay(200) // the opener is spawned detached; give a mistaken one time to write its log
  assert.deepEqual(await opener.opened(), [], 'nothing was handed to the opener')
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/api.test.mjs` → the new test FAILs (200, and the fake opener logs four launches — no real window opens).

- [ ] **Step 3: Implement** in `server/api.mjs`.

**3a.** Replace

```js
  const stat = await fsp.stat(dir).catch(() => null)
  return stat && stat.isDirectory() ? dir : null
}
```

with

```js
  const stat = await fsp.stat(dir).catch(() => null)
  return stat && stat.isDirectory() ? dir : null
}

/**
 * Every folder a scanned thread named — its repo, and the folder it runs in. A folder the page asks
 * to reveal or start a session in has to be one of these, not merely a directory that exists:
 * `/System/Applications/Calculator.app` is a directory that exists, and `open` launches it.
 *
 * The page only ever names a thread's own folders, so nothing it does is refused. The set is
 * refreshed on every poll, and a miss triggers one scan of its own first, in case the page holds a
 * thread this process has not seen yet — just restarted, say.
 */
let knownFolders = new Set()

function learnFolders(threads) {
  const next = new Set()
  for (const t of threads) {
    for (const folder of [t.projectPath, t.cwd]) {
      if (typeof folder === 'string' && path.isAbsolute(folder)) next.add(path.resolve(folder))
    }
  }
  knownFolders = next
}

async function isKnownFolder(dir) {
  if (knownFolders.has(dir)) return true
  learnFolders(await scanThreads())
  return knownFolders.has(dir)
}
```

**3b.** Replace

```js
    if (!cwd) return { ok: false, error: 'The folder that thread ran in is not on this machine any more' }
```

with

```js
    if (!cwd) return { ok: false, error: 'The folder that thread ran in is not on this machine any more' }
    // It arrived inside `ref`, from the page — the same allowlist as any folder the page names.
    if (!(await isKnownFolder(cwd))) return { ok: false, error: 'Bot Crossing has no thread in that folder' }
```

**3c.** Replace

```js
      const threads = await reconcileArchived(await scanThreads())
```

with

```js
      const threads = await reconcileArchived(await scanThreads())
      learnFolders(threads)
```

**3d.** Replace

```js
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })
```

with

```js
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })
      if (!(await isKnownFolder(dir))) {
        return send(res, 400, { ok: false, error: 'Bot Crossing has no thread in that folder' })
      }
```

- [ ] **Step 4: Run to verify pass.** `node --test test/api.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/api.mjs test/api.test.mjs
git commit -m "Reveal and start sessions only in folders a scanned thread named

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task S4: a failed colony write is an error reply, not a dead server

**Files:**
- Modify: `server/api.mjs`
- Test: `test/api.test.mjs`

- [ ] **Step 1: Write the failing test.** Append to `test/api.test.mjs`:

```js
// ── what it does when the disk misbehaves ─────────────────────────────────────

test('a colony write that fails is an error reply, not a crashed server', async () => {
  const dir = await scratch('notadir')
  const file = path.join(dir, 'notadir')
  await fsp.writeFile(file, 'a regular file where a folder should be')
  // ENOTDIR on the way to the data folder — much how a drive that has gone away fails.
  const api = await apiWith(path.join(file, 'data'))
  const res = await call(api, 'PUT', '/api/state', { body: { archived: ['x'] } })
  assert.ok(res.status >= 500 && res.status < 600, `got ${res.status}`)
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/api.test.mjs` → the new test FAILs with a rejected promise (`ENOTDIR … mkdir`) — in a real server, that is the process exiting.

- [ ] **Step 3: Implement.** In `server/api.mjs`, replace

```js
      return serialise(async () => {
```

with

```js
      // Awaited, not returned: a bare `return` settles the handler after the try block has already
      // exited, so a failed write escaped the catch below and took the whole server down with it.
      return await serialise(async () => {
```

- [ ] **Step 4: Run to verify pass.** `node --test test/api.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/api.mjs test/api.test.mjs
git commit -m "Keep a failed colony write inside the handler that made it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task S5: never replace a colony file the server could not read

**Files:**
- Modify: `server/api.mjs`, `src/game/api.js`
- Test: `test/api.test.mjs`

**Interfaces:**
- Produces: private `class StorageUnavailable extends Error`; `readState()` now throws it for anything but ENOENT; `writeState()` throws it for storage failures; handler answers it with 503.

- [ ] **Step 1: Write the failing tests.** Append to `test/api.test.mjs`:

```js
test('a colony file that is not valid JSON is reported, and never replaced', async () => {
  const dir = await scratch('data')
  const file = path.join(dir, 'colony.json')
  const typo = '{"version":2,"archived":["claude-code:a"],"plots":{"p":[[0,0]]},"updatedAt":1000,}'
  await fsp.writeFile(file, typo)
  const api = await apiWith(dir)
  assert.equal((await call(api, 'GET', '/api/state')).status, 503)
  assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: [] } })).status, 503)
  assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: [], baseUpdatedAt: 1000 } })).status, 503)
  assert.equal(await fsp.readFile(file, 'utf8'), typo, 'the file is exactly as it was')
})

test(
  'an unreadable colony file is reported, and never replaced',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    const dir = await scratch('data')
    const file = path.join(dir, 'colony.json')
    const good = JSON.stringify({ version: 2, archived: ['claude-code:a'], updatedAt: 1000 })
    await fsp.writeFile(file, good)
    await fsp.chmod(file, 0o000)
    try {
      const api = await apiWith(dir)
      assert.equal((await call(api, 'GET', '/api/state')).status, 503)
      assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: [] } })).status, 503)
    } finally {
      await fsp.chmod(file, 0o644)
    }
    assert.equal(await fsp.readFile(file, 'utf8'), good)
  }
)

test('a save against a colony file that has vanished does not start a new one', async () => {
  const dir = await scratch('data')
  const api = await apiWith(dir)
  const res = await call(api, 'PUT', '/api/state', { body: { archived: ['x'], baseUpdatedAt: 12345 } })
  assert.equal(res.status, 503)
  await assert.rejects(fsp.access(path.join(dir, 'colony.json')), 'nothing was written')
})

test('a first save against a real colony it never saw gets the disk state back, to merge', async () => {
  const dir = await scratch('data')
  await fsp.writeFile(path.join(dir, 'colony.json'), JSON.stringify({ version: 2, archived: ['claude-code:a'], updatedAt: 1000 }))
  const api = await apiWith(dir)
  const res = await call(api, 'PUT', '/api/state', { body: { archived: [] } })
  assert.equal(res.status, 409)
  assert.deepEqual(res.json.archived, ['claude-code:a'])
})

test('a data folder whose parent has gone is not quietly re-created', async () => {
  const root = await scratch('gone')
  const api = await apiWith(path.join(root, 'unmounted-drive', 'data'))
  assert.equal((await call(api, 'PUT', '/api/state', { body: { archived: ['x'] } })).status, 503)
  await assert.rejects(fsp.access(path.join(root, 'unmounted-drive')))
})

test('the thread list still answers when the colony file cannot be read', async () => {
  // Passes before this task too; it guards the new throw in readState from reaching /api/threads.
  const dir = await scratch('data')
  await fsp.writeFile(path.join(dir, 'colony.json'), '{ not json')
  const api = await apiWith(dir)
  const res = await call(api, 'GET', '/api/threads')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.threads, [])
})

test('a page will not merge an empty colony over the one it holds', async () => {
  const disk = {
    version: 2, archived: ['claude-code:a'], archivedAt: {}, opened: [], plots: { p: [[0, 0]] },
    seen: {}, hiddenProjects: [], viewedAt: {}, settings: null, updatedAt: 1000,
  }
  const emptied = { ...disk, archived: [], plots: {}, updatedAt: 0 }
  const realFetch = globalThis.fetch
  let puts = 0
  globalThis.fetch = async (_url, opts = {}) => {
    const answer = (status, body) => ({ ok: status < 300, status, statusText: '', json: async () => body })
    if ((opts.method || 'GET') === 'GET') return answer(200, disk)
    puts += 1
    return answer(409, emptied)
  }
  try {
    const { fetchState, saveState } = await import('../src/game/api.js')
    const state = await fetchState()
    await assert.rejects(saveState({ ...state, seen: { t: 1 } }))
    assert.equal(puts, 1, 'no second attempt, built on the empty colony')
  } finally {
    globalThis.fetch = realFetch
  }
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/api.test.mjs` → FAIL: invalid-JSON (200/200/409), unreadable (200s), vanished (409), first-save (200), parent-gone (200), page-merge (3 PUTs). The thread-list test PASSes.

- [ ] **Step 3: Implement.**

**3a.** In `server/api.mjs`, replace the whole `readState` function:

```js
async function readState() {
  try {
    const raw = migrate(JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')))
    return {
      version: STATE_VERSION,
      archived: asArray(raw.archived),
      archivedAt: asObject(raw.archivedAt),
      opened: asArray(raw.opened),
      plots: asObject(raw.plots),
      seen: asObject(raw.seen),
      hiddenProjects: asArray(raw.hiddenProjects).map(String).filter(Boolean),
      viewedAt: asObject(raw.viewedAt),
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return emptyState()
  }
}
```

with

```js
/**
 * The colony file is there but cannot be used — unreadable, not JSON, or its folder has gone.
 *
 * Kept apart from "no file yet" on purpose. That one is a fresh colony; this one is somebody's
 * colony we cannot see. Answering both with an empty state is what let the next save — whose base
 * the empty answer had just set to zero — overwrite a perfectly good file with nothing.
 */
class StorageUnavailable extends Error {}

async function readState() {
  let text
  try {
    text = await fsp.readFile(STATE_FILE, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyState()
    throw new StorageUnavailable(`Cannot read ${STATE_FILE} (${err?.code || err}); it has been left as it is`)
  }
  let raw
  try {
    raw = migrate(JSON.parse(text))
  } catch {
    throw new StorageUnavailable(`${STATE_FILE} is not valid JSON; it has been left as it is — fix or move it`)
  }
  return {
    version: STATE_VERSION,
    archived: asArray(raw.archived),
    archivedAt: asObject(raw.archivedAt),
    opened: asArray(raw.opened),
    plots: asObject(raw.plots),
    seen: asObject(raw.seen),
    hiddenProjects: asArray(raw.hiddenProjects).map(String).filter(Boolean),
    viewedAt: asObject(raw.viewedAt),
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
    updatedAt: Number(raw.updatedAt) || 0,
  }
}
```

**3b.** In `writeState`, replace

```js
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, STATE_FILE)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return state
```

with

```js
  // Not recursive, on purpose: the data folder may be created, but its parent must already be
  // there. A drive that has gone, or a repo moved while the server runs, then fails loudly here —
  // rather than quietly growing a fresh, empty colony somewhere nobody will ever look.
  await fsp.mkdir(DATA_DIR).catch((err) => {
    if (err.code !== 'EEXIST') {
      throw new StorageUnavailable(`Cannot use ${DATA_DIR} (${err.code}); its parent folder has to exist`)
    }
  })
  const tmp = `${STATE_FILE}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, STATE_FILE)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new StorageUnavailable(`Cannot write ${STATE_FILE} (${err.code || err})`)
  }
  return state
```

**3c.** In `reconcileArchived`, replace

```js
  const state = await readState()
  if (!state.archived.length) return threads
```

with

```js
  let state
  try {
    state = await readState()
  } catch {
    // A colony file that cannot be read says nothing about what is archived. The map still draws;
    // the archive list comes back when the file does.
    return threads
  }
  if (!state.archived.length) return threads
```

**3d.** Replace

```js
     * A missing or zero base is a first write and is allowed: nothing to lose on a fresh
     * install, and it keeps the endpoint drivable from `curl`.
     */
```

with

```js
     * A zero base is a first write, allowed only while there is nothing on disk to lose — a fresh
     * install, or `curl` against one. Against a real colony it gets the disk state back to merge,
     * like any stale save. A base with no file behind it at all is a colony that has gone (the
     * file, or the drive under it), and gets a 503: starting a new one from the page's copy would
     * bury the real one the moment it came back.
     */
```

**3e.** Replace

```js
        const current = await readState()
        if (base && current.updatedAt !== base) return send(res, 409, current)
        return send(res, 200, await writeState(body))
```

with

```js
        const current = await readState()
        if (base && !current.updatedAt) {
          return send(res, 503, { error: 'The colony file has gone; not starting a new one over it' })
        }
        if (current.updatedAt !== base) return send(res, 409, current)
        return send(res, 200, await writeState(body))
```

**3f.** Replace

```js
  } catch (err) {
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
```

with

```js
  } catch (err) {
    // Storage the server cannot use is its own answer: the page keeps what it holds and tries
    // again later, rather than treating the colony as empty.
    if (err instanceof StorageUnavailable) return send(res, 503, { error: err.message })
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
```

**3g.** In `src/game/api.js`, replace

```js
    if (res.status === 409) {
      local = mergeState(baseSnapshot, local, body)
```

with

```js
    if (res.status === 409) {
      // A conflict that hands back a colony with no version, while this tab holds a versioned one,
      // is not another tab's work — it is a disk that went backwards to nothing. Merging it would
      // count everything this tab holds as deleted on the other side, and write that down.
      if (baseUpdatedAt && !Number(body.updatedAt)) {
        throw new Error('The colony file came back empty; not saving over it')
      }
      local = mergeState(baseSnapshot, local, body)
```

- [ ] **Step 4: Run to verify pass.** `node --check server/api.mjs && node --test test/api.test.mjs` → all PASS.

- [ ] **Step 5: Commit.**

```bash
git add server/api.mjs src/game/api.js test/api.test.mjs
git commit -m "Never replace a colony file the server could not read

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task S6: the built-app server survives bad input and checks Host on every route

**Files:**
- Modify: `server/serve.mjs` (full replacement below)
- Create: `test/serve.test.mjs`

**Interfaces:**
- Consumes: `isLocalHost` (S1), `inject` (S1).
- Produces: `export async function handler(req, res)`; the server listens only when `serve.mjs` is the entry point.

- [ ] **Step 1: Write the failing tests.** Create `test/serve.test.mjs`:

```js
/**
 * The built-app server (`npm run serve`), driven in-process. It has to survive whatever a browser —
 * or, with BOT_CROSSING_HOST set, anything else on the network — sends it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inject } from './support/inject.mjs'

process.env.BOT_CROSSING_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-crossing-serve-'))
delete process.env.BOT_CROSSING_HOST
const { handler } = await import('../server/serve.mjs')

test('a path whose % escape decodes to nothing is a 400, not a dead server', async () => {
  const res = await inject(handler, { url: '/%E0%A4%A', headers: { host: 'localhost:5274' } })
  assert.equal(res.status, 400)
})

test("the app's files answer only to this machine's own Host, as the API does", async () => {
  const res = await inject(handler, { url: '/index.html', headers: { host: 'evil.example:5274' } })
  assert.equal(res.status, 403)
})
```

- [ ] **Step 2: Run to verify failure.** `node --test test/serve.test.mjs` → FAIL: `handler` is not exported (and the old module tries to listen on import).

- [ ] **Step 3: Implement.** Replace the whole of `server/serve.mjs` with:

```js
import http from 'node:http'
import fsp from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apiMiddleware, isLocalHost } from './api.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, '..', 'dist')
const PORT = Number(process.env.PORT) || 5274
const HOST = process.env.BOT_CROSSING_HOST || '127.0.0.1'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** Resolve inside dist/ only — a request can never climb out with `..`. */
function resolveInDist(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = path.resolve(DIST, rel || 'index.html')
  return file === DIST || file.startsWith(DIST + path.sep) ? file : null
}

/**
 * One request, start to finish. Exported for the tests, which want this and not a socket.
 *
 * Nothing may throw past it: a rejection out of an `http` handler is unhandled, and Node's answer to
 * one of those is to end the process — so one malformed URL, or one failed save, took the whole
 * colony down with it.
 */
export async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname.startsWith('/api/')) return await apiMiddleware(req, res, null)

    // The API checks Host itself. The app's own files get the same DNS-rebinding check here.
    if (!isLocalHost(req)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    let file
    try {
      file = resolveInDist(url.pathname)
    } catch {
      res.writeHead(400).end('Bad request') // a `%` escape that decodes to nothing
      return
    }
    if (!file) {
      res.writeHead(403).end('Forbidden')
      return
    }
    try {
      if ((await fsp.stat(file)).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      file = path.join(DIST, 'index.html') // SPA fallback
    }

    try {
      const body = await fsp.readFile(file)
      const type = TYPES[path.extname(file)] || 'application/octet-stream'
      const cache = file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache })
      res.end(body)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end(String(err?.message || err))
  }
}

/** Run as `node server/serve.mjs` — not when a test imports `handler`. */
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  const server = http.createServer(handler)
  server.on('error', (err) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Bot Crossing: port ${PORT} is already in use — is another copy running? Set PORT to run a second.`
        : `Bot Crossing: ${err.message}`
    )
    process.exit(1)
  })
  server.listen(PORT, HOST, () => {
    console.log(`Bot Crossing → http://${HOST}:${PORT}`)
  })
}
```

- [ ] **Step 4: Run to verify pass.** `node --test test/serve.test.mjs && node --test test/api.test.mjs` → all PASS, and the process exits by itself (nothing left listening).

- [ ] **Step 5: Commit.**

```bash
git add server/serve.mjs test/serve.test.mjs
git commit -m "Keep the built-app server up through bad input, and check Host on every route

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

# After both tracks (orchestrator)

- **M1 — merge and full suite (sandbox off):** in the main checkout on `asmg/main`: `git merge --no-ff fix/harness` then `git merge --no-ff fix/server` (disjoint files; no conflicts expected), then `npm test` → every file green, including `test/state.test.mjs`.
- **M2 — docs:** README "Keeping it local" (exact-origin rule, `Sec-Fetch-Site`, LAN trust only with `BOT_CROSSING_HOST`, the corrected write set), "Clicking one" (folder buttons only for folders a thread named), and a `BOT_CROSSING_DATA` note (its parent folder must exist). One commit.
- **M3 — local ops (not committed):** move this machine's colony state off the external drive (`BOT_CROSSING_DATA="$HOME/Library/Application Support/bot-crossing/data"`, copy, keep the original), point the hub's preview config at it, restart the dev server.
- **M4 — live verification** against the real machine: no made-up zones, `need you` count, no duplicates, the live session shows as building while its workflow runs, a cross-port Origin gets 403, a folder outside the scan gets 400.
- **M5 — final whole-branch review** of `main..asmg/main`.
