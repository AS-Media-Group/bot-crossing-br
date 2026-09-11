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
