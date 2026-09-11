/**
 * Harness adapter: Claude Code (Anthropic) — the desktop app and the CLI together.
 *
 * Everything that knows the shape of Claude Code's own files lives in this one module.
 * `server/scan.mjs` never reaches past the adapter interface, so adding another harness
 * means writing a sibling of this file rather than editing the scanner. The contract is
 * written down in `server/harnesses/README.md`.
 *
 * Read-only, without exception. Nothing here writes to Claude Code's files — see the note on
 * archiving in `server/harnesses/README.md`.
 *
 * Two stores, deliberately merged rather than picked between:
 *   - the desktop app keeps one JSON record per thread (title, cwd, model, timestamps)
 *   - the CLI keeps the raw transcript, which is the only source for terminal-started work
 */
import fsp from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  exists, findExecutable, jsonLines, listDirs, listFiles, num, readHead, readRecordsUntil, readTail,
} from '../lib/fsutil.mjs'

const HOME = os.homedir()

/**
 * Where the Claude desktop app keeps its data: Electron's `userData` for an app named
 * "Claude", which lands somewhere different on each OS.
 */
function desktopDataDir() {
  switch (process.platform) {
    case 'win32':
      return windowsDataDir()
    case 'linux':
      return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude')
    default:
      return path.join(HOME, 'Library', 'Application Support', 'Claude')
  }
}

/**
 * Windows has two answers, because the app ships two ways.
 *
 * The classic installer writes to `%APPDATA%\Claude`, which is what Electron's `userData` means
 * everywhere else. Installed from the Microsoft Store the app is an MSIX package, and MSIX
 * *redirects* what a packaged app believes is `%APPDATA%` into its own private
 * `…\Packages\<family>\LocalCache\Roaming`. The app is installed, running and writing session
 * records — and `%APPDATA%\Claude` does not exist at all.
 *
 * The package folder is globbed rather than named: its suffix is a hash of the publisher, and
 * hard-coding that buys a constant which is right until it is not, and then wrong in a way that
 * looks exactly like the app having been uninstalled.
 *
 * Resolved once, at import. Installing the app while the colony is running therefore wants a
 * restart to be noticed — a knowing trade, since the alternative is globbing `Packages` on every
 * scan to catch something that happens once.
 */
function windowsDataDir() {
  const roaming = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude')
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
  const candidates = [roaming]
  try {
    for (const entry of readdirSync(path.join(local, 'Packages'), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('Claude_')) {
        candidates.push(path.join(local, 'Packages', entry.name, 'LocalCache', 'Roaming', 'Claude'))
      }
    }
  } catch {
    /* no Packages directory — this machine has no Store apps at all */
  }
  // Whichever actually holds the records. Falling back to the unpackaged path keeps every
  // caller working against a real path when neither exists, which `detect()` reads as "no app".
  return candidates.find((dir) => existsSync(path.join(dir, 'claude-code-sessions'))) || roaming
}

/** Where the Claude desktop app keeps one JSON record per thread. */
const DESKTOP_SESSIONS = path.join(desktopDataDir(), 'claude-code-sessions')
/** Where the CLI keeps the raw transcript: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
const CLI_PROJECTS = path.join(HOME, '.claude', 'projects')
/** One file per live CLI process: {pid, sessionId, cwd, ...}. Stale files outlive their pid. */
const CLI_LIVE = path.join(HOME, '.claude', 'sessions')

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

/**
 * How recently a session must have done something to count as "active now".
 * A live process on its own is not enough: the desktop app pre-warms idle sessions, so
 * threads untouched for days still hold a CLI process. Measured against real data, the
 * warmed ones sat 16 hours to 3 days idle while genuinely active work was minutes old.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

/**
 * How long a desktop thread with no focus history counts as asking for you. Records the app wrote
 * before it kept `lastFocusedAt` have no such field, and reading its absence as "never opened" put a
 * `?` over every one of them — months of threads, all waving. Absent is unknowable, so only a
 * thread recent enough to plausibly be new is taken as unread on the strength of it: the same three
 * days after which an astronaut falls asleep anyway.
 */
const NEVER_FOCUSED_MS = 3 * 24 * 60 * 60 * 1000

/** How close a desktop thread's creation and a transcript's first record must be to be one event. */
const SAME_MOMENT_MS = 60 * 1000

/**
 * How recently a session's subagents must have written for the session to count as working. A
 * thread that handed the turn back while a background agent or workflow it started carries on has a
 * quiet transcript — and a busy folder beside it.
 */
const BACKGROUND_WINDOW_MS = 2 * 60 * 1000

/**
 * Every id this adapter hands out is prefixed. `server/harnesses/README.md` asks for ids unique
 * across harnesses, and while two UUIDs will not collide, the colony keys its archive list and
 * saved layout on this string — so it is worth being unambiguous rather than merely lucky.
 */
const ID = (raw) => `claude-code:${raw}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DESKTOP_ID = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The type check matters wherever an id came back from the page: `RegExp.test` stringifies, so a
// one-element array holding a valid id would pass the pattern and then travel on as an array.
const isCliId = (v) => typeof v === 'string' && UUID.test(v)
const isDesktopId = (v) => typeof v === 'string' && DESKTOP_ID.test(v)

function firstText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') return part
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text
    }
  }
  return ''
}

/** Strip <system-reminder>/<command-*> noise the CLI wraps around prompts. */
function cleanPrompt(s) {
  return String(s)
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pull whatever a transcript knows about itself: title, cwd, branch, start time.
 * Mirrors the CLI's own title precedence: custom > ai > summary > first prompt.
 */
function readTranscriptMeta(records) {
  const meta = {
    customTitle: '', aiTitle: '', summary: '', firstPrompt: '', cwd: '', gitBranch: '', startedAt: 0, rootUuid: '',
  }
  for (const r of records) {
    if (!meta.customTitle && r.customTitle) meta.customTitle = r.customTitle
    if (!meta.aiTitle && r.aiTitle) meta.aiTitle = r.aiTitle
    if (!meta.summary && r.type === 'summary' && r.summary) meta.summary = r.summary
    if (!meta.cwd && r.cwd) meta.cwd = r.cwd
    if (!meta.gitBranch && r.gitBranch && r.gitBranch !== 'HEAD') meta.gitBranch = r.gitBranch
    if (!meta.startedAt && r.timestamp) {
      const t = Date.parse(r.timestamp)
      if (!Number.isNaN(t)) meta.startedAt = t
    }
    if (!meta.firstPrompt && r.type === 'user' && r.message) {
      const text = cleanPrompt(firstText(r.message.content))
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

/**
 * `/repo/.claude/worktrees/feature-abc` -> project `/repo`, worktree `feature-abc`.
 * Either separator: on Windows the same cwd arrives as `C:\repo\.claude\worktrees\…`.
 */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/
function splitWorktree(cwd) {
  const m = WORKTREE.exec(cwd)
  if (!m) return { root: cwd, worktree: '' }
  return { root: cwd.slice(0, m.index), worktree: m[1] }
}

function projectOf(cwd, originCwd) {
  const { root, worktree } = splitWorktree(cwd || '')
  const projectPath = originCwd || root || cwd || ''
  return { projectPath, project: path.basename(projectPath) || projectPath || 'unknown', worktree }
}

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

/** Index every CLI transcript on disk, keyed by session id. */
async function scanTranscripts() {
  const byId = new Map()
  for (const projectDir of await listDirs(CLI_PROJECTS)) {
    for (const file of await listFiles(projectDir, (n) => n.endsWith('.jsonl'))) {
      const id = path.basename(file, '.jsonl')
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      byId.set(id, { id, file, projectDir, size: stat.size, mtime: stat.mtimeMs })
    }
  }
  return byId
}

/** How much of a transcript's end it takes to see whose turn it is. One record is plenty. */
const TAIL_BYTES = 64 * 1024

/**
 * How far back to look when the tail above holds no timestamped record at all. `readTail` drops the
 * partial line its window starts in, so a last record bigger than the window — a screenshot, a long
 * tool result — or a batch of bookkeeping bigger than it leaves nothing to date the thread by, and
 * falling back to mtime is the very bug the tail exists to fix. The tail itself stays small because
 * nearly every transcript is answered by it; only one that is not pays for this, once per change.
 */
const WIDE_TAIL_BYTES = 2 * 1024 * 1024

/** Transcript metadata is expensive to parse, so keep it until the file changes. */
const metaCache = new Map()
async function transcriptMeta(entry) {
  const cached = metaCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime) return cached.meta
  let meta
  try {
    meta = readTranscriptMeta(jsonLines(await readHead(entry.file, HEAD_BYTES)))
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
  const tail = {
    lastRecordAt: 0, relocatedCwd: '', cwd: '', gitBranch: '', customTitle: '', aiTitle: '',
    endsInSession: '', handedBack: false, handedBackAt: 0,
  }
  let turn = null
  for (const r of records) {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN
    if (!Number.isNaN(t) && t > tail.lastRecordAt) tail.lastRecordAt = t
    if (typeof r.relocatedCwd === 'string' && r.relocatedCwd) tail.relocatedCwd = r.relocatedCwd
    if (typeof r.cwd === 'string' && r.cwd) tail.cwd = r.cwd
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
}

/** The tail, like the head, is kept until the file changes. */
const tailCache = new Map()
async function transcriptTail(entry) {
  const cached = tailCache.get(entry.id)
  if (cached && cached.mtime === entry.mtime) return cached.tail
  let tail
  try {
    tail = readTranscriptTail(jsonLines(await readTail(entry.file, TAIL_BYTES)))
    // No timestamp in a tail shorter than the file is a window that ran out inside one big record,
    // not a transcript with nothing to date it by. Once, wider, and bounded — then whatever it says.
    if (!tail.lastRecordAt && entry.size > TAIL_BYTES) {
      tail = readTranscriptTail(jsonLines(await readTail(entry.file, WIDE_TAIL_BYTES)))
    }
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
 *
 * The tail's own latest cwd is a candidate as well as the record of the move. That record is written
 * once, and a session that goes on working pushes it out of the tail within a few file reads; every
 * record after it carries the new cwd, though. Asking the move alone sent such a thread back to the
 * repo root it began in, and resuming it ran there — where its transcript is not.
 *
 * When none of them encodes to it, the folder is resolved before the opening cwd is fallen back on:
 * that one has just been shown not to be where the transcript lives.
 */
function whereItRuns(dirName, meta, tail, known) {
  for (const cwd of [tail.relocatedCwd, tail.cwd, meta.cwd]) {
    if (cwd && encodeProjectDir(cwd) === dirName) return cwd
  }
  return resolveProjectDir(dirName, known) || meta.cwd || tail.cwd
}

/**
 * Sessions with a CLI process actually alive right now. The registry keeps files for
 * processes that have exited, so every pid is probed before it counts.
 */
async function scanLiveSessions() {
  const live = new Set()
  for (const file of await listFiles(CLI_LIVE, (n) => n.endsWith('.json'))) {
    let record
    try {
      record = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue
    }
    if (!record.sessionId || !record.pid) continue
    try {
      process.kill(record.pid, 0) // signal 0 only tests for existence
      live.add(record.sessionId)
    } catch (err) {
      // EPERM is a process that exists but is not ours to signal — alive. Only ESRCH means gone. A
      // pid recycled by somebody else's process reads as alive too, which is why being live is never
      // enough to count as working: the transcript has to have moved as well.
      if (err.code === 'EPERM') live.add(record.sessionId)
    }
  }
  return live
}

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
async function scanDesktopSessions() {
  const out = []
  for (const account of await listDirs(DESKTOP_SESSIONS)) {
    for (const org of await listDirs(account)) {
      for (const file of await listFiles(org, (n) => n.startsWith('local_') && n.endsWith('.json'))) {
        try {
          out.push(JSON.parse(await fsp.readFile(file, 'utf8')))
        } catch {
          /* a session mid-write — skip this pass */
        }
      }
    }
  }
  return out
}

/**
 * Two desktop records can point at one transcript — resuming a thread that is already
 * open makes the app write a second, untitled record. Keep the richer of the two.
 */
function mergeThread(existing, next) {
  const better = (a, b) => (a && a !== 'Untitled thread' ? a : b || a)
  // The titled record is the real thread; an untitled twin is the import ghost. Point
  // the canonical id at the real one, but keep both so archiving covers the ghost too.
  const keepExisting = existing.titled || !next.titled
  return {
    ...existing,
    ...next,
    title: better(existing.title, next.title),
    titled: existing.titled || next.titled,
    preview: existing.preview || next.preview,
    desktopSessionId: keepExisting ? existing.desktopSessionId : next.desktopSessionId,
    desktopSessionIds: [...new Set([...existing.desktopSessionIds, ...next.desktopSessionIds])],
    bridgeSessionId: existing.bridgeSessionId || next.bridgeSessionId,
    model: existing.model || next.model,
    effort: existing.effort || next.effort,
    gitBranch: existing.gitBranch || next.gitBranch,
    cwd: existing.cwd || next.cwd,
    createdAt: Math.min(existing.createdAt || Infinity, next.createdAt || Infinity) || 0,
    lastActivityAt: Math.max(existing.lastActivityAt || 0, next.lastActivityAt || 0),
    lastFocusedAt: Math.max(existing.lastFocusedAt || 0, next.lastFocusedAt || 0),
    hasFocusStamp: existing.hasFocusStamp || next.hasFocusStamp,
    hasError: existing.hasError || next.hasError,
    hasLiveProcess: existing.hasLiveProcess || next.hasLiveProcess,
    handedBack: existing.handedBack || next.handedBack,
    handedBackAt: Math.max(existing.handedBackAt || 0, next.handedBackAt || 0),
    starred: existing.starred || next.starred,
    routine: existing.routine || next.routine,
    prState: existing.prState || next.prState,
    archived: existing.archived && next.archived,
    hasTranscript: existing.hasTranscript || next.hasTranscript,
  }
}

/**
 * Fold the adapter's private bookkeeping into the shape the rest of the app sees.
 * The session ids stay, but behind `ref` — an opaque blob the browser hands straight
 * back on open/archive, so nothing outside this file has to know what a Claude session
 * id looks like.
 */
function toThread(t) {
  const {
    desktopSessionId, desktopSessionIds, cliSessionId, bridgeSessionId,
    titled, hasLiveProcess, transcriptFile, recordActivityAt, hasFocusStamp, handedBack, handedBackAt, ...rest
  } = t
  return {
    ...rest,
    canOpen: isDesktopId(desktopSessionId) || isCliId(cliSessionId),
    // The cwd rides along because resuming from a terminal has to happen in the folder the
    // session ran in — the worktree, not the repo root.
    ref: { desktopSessionId, desktopSessionIds, cliSessionId, cwd: t.cwd || '' },
  }
}

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
 *     moment that thread was created, and wrote nothing after that thread's own transcript last did.
 *     Whatever it holds beyond the copy is a turn somebody rewound, not a thread anybody is working in.
 *
 * "Last did" is the owner transcript's last timestamped record, never the desktop record's stamps.
 * Those fall back to when you last looked at the thread, and measured against that, merely opening
 * it was enough to hide a genuine continuation.
 *
 * A transcript that did anything after its would-be owner is a continuation, and stays.
 */
function supersededBy(id, entry, meta, tail, transcripts, rootOwners) {
  const other = tail.endsInSession
  if (other && other !== id && transcripts.has(other)) return ID(other)
  for (const owner of rootOwners.get(meta.rootUuid) || []) {
    const sameMoment = Math.abs(owner.createdAt - meta.startedAt) <= SAME_MOMENT_MS
    if (sameMoment && activityOf(entry, tail) <= owner.activeAt) return owner.id
  }
  return ''
}

async function scanThreads() {
  const [desktop, transcripts, live] = await Promise.all([
    scanDesktopSessions(),
    scanTranscripts(),
    scanLiveSessions(),
  ])
  const byId = new Map()
  const add = (thread) => {
    const existing = byId.get(thread.id)
    byId.set(thread.id, existing ? mergeThread(existing, thread) : thread)
  }
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
  /** Which desktop thread began each conversation — the one the app opened on it, never a fork. */
  const rootOwners = new Map()

  for (const s of desktop) {
    const cliSessionId = s.cliSessionId || ''
    const entry = cliSessionId ? transcripts.get(cliSessionId) : null
    if (entry) claimed.add(cliSessionId)

    const cwd = s.cwd || s.originCwd || ''
    const { projectPath, project, worktree } = projectOf(cwd, s.originCwd)
    const meta = entry ? await transcriptMeta(entry) : null
    const tail = entry ? await transcriptTail(entry) : null
    learn(s.cwd)
    learn(s.originCwd)
    learn(meta?.cwd)
    learn(tail?.relocatedCwd)
    learn(tail?.cwd)

    // The desktop record's own stamp lags: the app writes it when the thread is focused, so a
    // session running in a terminal — or in a window you are not looking at — reads as hours
    // old while its transcript is being written to right now. The later of the two is true.
    const lastActivityAt = Math.max(
      num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
      entry ? activityOf(entry, tail) : 0
    )
    if (meta?.rootUuid && !s.forkedFromSessionId) {
      const owners = rootOwners.get(meta.rootUuid) || []
      // Its transcript's own last record, not the display stamp above: with no `lastActivityAt` that
      // falls back to when you last looked, and opening a thread must not raise the bar a continuation
      // has to clear. A root uuid came from a transcript, so there is always an entry to ask.
      owners.push({
        id: ID(cliSessionId || s.sessionId), createdAt: num(s.createdAt), activeAt: activityOf(entry, tail),
      })
      rootOwners.set(meta.rootUuid, owners)
    }

    add({
      id: ID(cliSessionId || s.sessionId),
      cliSessionId,
      desktopSessionId: s.sessionId || '',
      desktopSessionIds: s.sessionId ? [s.sessionId] : [],
      titled: Boolean(s.title),
      bridgeSessionId: (s.bridgeSessionIds && s.bridgeSessionIds[0]) || '',
      title: s.title || titleOf(meta, tail) || 'Untitled thread',
      preview: meta?.firstPrompt ? meta.firstPrompt.slice(0, 240) : '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: tail?.gitBranch || meta?.gitBranch || '',
      model: s.model || '',
      effort: s.effort || '',
      createdAt: num(s.createdAt) || meta?.startedAt || 0,
      lastActivityAt,
      // Kept apart from the above. "Unread" compares against when you last *looked*, and both
      // sides have to come from the app's own bookkeeping: measure a transcript mtime against
      // `lastFocusedAt` instead and every background write puts a `?` over half the colony.
      recordActivityAt: num(s.lastActivityAt) || num(s.lastFocusedAt) || num(s.createdAt) || 0,
      lastFocusedAt: num(s.lastFocusedAt),
      hasFocusStamp: 'lastFocusedAt' in s,
      hasLiveProcess: live.has(cliSessionId),
      handedBack: tail?.handedBack || false,
      handedBackAt: tail?.handedBackAt || 0,
      hasError: Boolean(s.error),
      starred: s.isStarred === true,
      routine: s.scheduledTaskId || '',
      prState: s.prState || '',
      archived: s.isArchived === true || s.isArchived === 'True',
      hasTranscript: Boolean(entry),
      sizeBytes: entry?.size || 0,
      transcriptFile: entry?.file || '',
      source: 'desktop',
    })
  }

  // Transcripts with no desktop record — usually threads started straight from the terminal.
  // All of them are read first (cached, so free after the first poll), so that every path they
  // report is known before any one of them needs a folder resolved.
  const loose = []
  for (const [id, entry] of transcripts) {
    if (claimed.has(id)) continue
    const meta = await transcriptMeta(entry)
    const tail = await transcriptTail(entry)
    learn(meta.cwd)
    learn(tail.relocatedCwd)
    learn(tail.cwd)
    loose.push({ id, entry, meta, tail })
  }

  for (const { id, entry, meta, tail } of loose) {
    if (supersededBy(id, entry, meta, tail, transcripts, rootOwners)) continue
    const cwd = whereItRuns(path.basename(entry.projectDir), meta, tail, known)
    const { projectPath, project, worktree } = projectOf(cwd, '')
    add({
      id: ID(id),
      cliSessionId: id,
      desktopSessionId: '',
      desktopSessionIds: [],
      titled: Boolean(tail.customTitle || meta.customTitle || tail.aiTitle || meta.aiTitle),
      bridgeSessionId: '',
      title: titleOf(meta, tail) || 'Untitled thread',
      preview: meta.firstPrompt ? meta.firstPrompt.slice(0, 240) : '',
      project,
      projectPath,
      worktree,
      cwd,
      gitBranch: tail.gitBranch || meta.gitBranch,
      model: '',
      effort: '',
      createdAt: meta.startedAt || entry.mtime,
      lastActivityAt: activityOf(entry, tail),
      lastFocusedAt: 0,
      hasFocusStamp: false,
      hasLiveProcess: live.has(id),
      handedBack: tail.handedBack,
      handedBackAt: tail.handedBackAt,
      hasError: false,
      starred: false,
      routine: '',
      prState: '',
      archived: false,
      hasTranscript: true,
      sizeBytes: entry.size,
      transcriptFile: entry?.file || '',
      source: 'cli',
    })
  }

  const now = Date.now()

  /**
   * Drop the app's empty bookkeeping records.
   *
   * Resuming a thread makes the desktop app write a second record for the same conversation, and
   * one of the two carries the title and the transcript link while the other carries nothing.
   * With no `cliSessionId` on the empty one there is no key to merge the pair on, so it survives
   * as a thread of its own: an untitled entry with no transcript behind it, standing on the map
   * as a nameless twin of a thread you have already dealt with.
   *
   * A record with no transcript, no title and no live process is not a conversation. The age
   * check keeps a genuinely new session — opened seconds ago, nothing written yet — out of it.
   */
  const NEW_SESSION_MS = 10 * 60 * 1000
  const threads = [...byId.values()].filter(
    (t) =>
      t.hasTranscript ||
      t.titled ||
      t.hasLiveProcess ||
      now - (t.lastActivityAt || t.createdAt || 0) < NEW_SESSION_MS
  )

  // Unread = the thread moved on after you last looked at it; a recent thread never opened counts
  // as unread. Terminal-only threads have no focus history at all, so "unread" is unknowable — not
  // true.
  for (const thread of threads) {
    const seenAt = thread.recordActivityAt ?? thread.lastActivityAt
    const moved = thread.hasFocusStamp ? seenAt > thread.lastFocusedAt : now - seenAt < NEVER_FOCUSED_MS
    thread.unread = thread.desktopSessionIds.length > 0 && moved
    const subagentAt =
      thread.hasLiveProcess && thread.transcriptFile
        ? await newestSubagentWrite(thread.transcriptFile, thread.cliSessionId)
        : 0
    const fresh = now - Math.max(thread.lastActivityAt, subagentAt) < ACTIVE_WINDOW_MS
    // Only agent writes after the hand-back are work still going on. A foreground agent writes beside
    // the transcript as well, and the turn that ran one answers seconds after its last write: counted,
    // that write read a thread waiting on you as working — `?` hidden — for the rest of the window. A
    // thread mid-turn has handed nothing back (`handedBackAt` is 0), so every write still counts there.
    const background = subagentAt > thread.handedBackAt && now - subagentAt < BACKGROUND_WINDOW_MS
    const waiting = thread.hasLiveProcess && fresh && thread.handedBack
    thread.running = thread.hasLiveProcess && (background || (fresh && !waiting))
    // A thread that handed the turn back wants you, whether or not the desktop app has ever seen
    // it — the only way a terminal-only thread can ask for anything at all. Unless you have looked
    // at it since: the desktop app records that, and looking is the answer to "is it waiting?".
    const lookedSince = thread.handedBackAt > 0 && thread.lastFocusedAt >= thread.handedBackAt
    if (waiting && !lookedSince) thread.unread = true
  }
  return threads.map(toThread)
}

/**
 * Where the `claude` CLI is, for a machine that has it but no desktop app to answer the deep
 * link. PATH first, then the places its installers put it — never inside an application bundle.
 * Only Linux asks: on macOS and Windows the deep link is always answered, so the walk is wasted.
 */
const CLI_DIRS = [
  path.join(HOME, '.local', 'bin'),
  path.join(HOME, '.claude', 'local'),
  '/usr/local/bin',
  '/usr/bin',
]
const cliBinary = () => findExecutable('claude', CLI_DIRS)

/**
 * Hands the thread back to Claude Code. `epitaxy/<local_…>` *navigates* the desktop app
 * to a thread it already has; `resume` *imports* the transcript, which spawns a second
 * untitled session and rewrites the .jsonl — so it is only ever the fallback for threads
 * the app has never seen. Ids are pattern-checked before they reach the opener.
 */
async function openThread(ref) {
  const { desktopSessionId, cliSessionId, cwd } = ref || {}
  let url = ''
  if (isDesktopId(desktopSessionId)) url = `claude://claude.ai/epitaxy/${desktopSessionId}`
  else if (isCliId(cliSessionId)) url = `claude://resume?session=${cliSessionId}`

  let command
  if (process.platform === 'linux' && isCliId(cliSessionId)) {
    const bin = await cliBinary()
    if (bin) command = { argv: [bin, '--resume', cliSessionId], cwd: typeof cwd === 'string' ? cwd : '' }
  }

  if (!url && !command) return { ok: false, error: 'No openable session id on that thread' }
  return { ok: true, url, command }
}

/**
 * A brand new thread rooted in a repo — the same `code/new?folder=` deep link Finder's
 * "New Claude Code Session Here" quick action uses. Nothing is resumed and nothing is
 * written: the desktop app just opens an empty session with that folder as its workspace.
 */
async function newSession(dir) {
  // encodeURIComponent, not URLSearchParams: the quick action sends `%20`, and `+` only means a
  // space to a form parser — a handler that decodes with decodeURIComponent reads a literal plus.
  const url = `claude://code/new?folder=${encodeURIComponent(dir)}`
  let command
  if (process.platform === 'linux') {
    const bin = await cliBinary()
    if (bin) command = { argv: [bin], cwd: dir }
  }
  return { ok: true, url, command }
}

export default {
  id: 'claude-code',
  name: 'Claude Code',
  /** Only claim this machine if one of the two stores is actually there. */
  detect: async () => (await exists(DESKTOP_SESSIONS)) || (await exists(CLI_PROJECTS)),
  scanThreads,
  openThread,
  newSession,
  paths: { DESKTOP_SESSIONS, CLI_PROJECTS, CLI_LIVE },
}
