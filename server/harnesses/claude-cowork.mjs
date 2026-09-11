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

/**
 * How recently a live session's transcript must have moved to count as working. A process on its
 * own is not enough: one can outlive its work, and a session at rest writes nothing.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RECORD = /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
/** A routine's id becomes part of a thread id, so only the app's own kebab-case shape is taken. */
const TASK_ID = /^[a-z0-9][a-z0-9-]*$/

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
async function threadFor(id, run, { folders, routine = '', createdAt = 0, fallbackTitle = '' }, now) {
  const folder = await firstFolder(folders)
  const transcript = await transcriptOf(run)
  const live = transcript ? await isLive(run) : false
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
    running: live && now - transcript.mtime < ACTIVE_WINDOW_MS,
    hasError: run.hasError,
    starred: run.isStarred,
    routine,
    prState: '',
    archived: run.isArchived,
    sizeBytes: transcript ? transcript.size : 0,
    source: 'cowork',
    canOpen: false,
    ref: { sessionId: run.sessionId },
  }
}

async function scanThreads() {
  const now = Date.now()
  const orgs = await orgDirs()
  const enabled = new Map()
  // Keyed by org too: two orgs are free to enable a routine with the same id.
  for (const org of orgs) {
    for (const [taskId, task] of await routinesIn(org)) enabled.set(`${path.basename(org)}:${taskId}`, task)
  }

  const threads = []
  const runs = new Map()
  for (const record of await recentRecords(orgs, now)) {
    if (now - record.lastActivityAt > WINDOW_MS) continue
    if (record.scheduledTaskId || record.sessionType === 'scheduled') {
      const orgId = path.basename(path.dirname(record.sessionDir))
      const key = `${orgId}:${record.scheduledTaskId}`
      // A run of a routine that has since been switched off, or of none at all, is history.
      if (!enabled.has(key)) continue
      if (!runs.has(key)) runs.set(key, [])
      runs.get(key).push(record)
      continue
    }
    threads.push(await threadFor(ID(record.sessionId), record, { folders: record.userSelectedFolders }, now))
  }

  /*
   * One astronaut per routine, whatever it has run since. A daily routine is hundreds of records and
   * would bury every other zone on the map; as one thread it is a place to see at a glance whether
   * this morning's run worked. Its id is the routine's, not a run's, so the astronaut stays put from
   * one day's run to the next. The org rides along in that id too, since routine ids are only unique
   * within their own org.
   */
  for (const [key, list] of runs) {
    list.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    const latest = list[0]
    const taskId = latest.scheduledTaskId
    const folders = latest.userSelectedFolders.length ? latest.userSelectedFolders : enabled.get(key).folders
    const createdAt = Math.min(...list.map((r) => r.createdAt || r.lastActivityAt))
    threads.push(
      await threadFor(ID(`task:${key}`), latest, {
        folders, routine: taskId, createdAt, fallbackTitle: taskId,
      }, now),
    )
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
