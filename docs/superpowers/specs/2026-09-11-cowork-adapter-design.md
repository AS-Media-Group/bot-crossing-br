# Cowork on the map: a read-only `claude-cowork` adapter

**Date:** 2026-09-11 · **Branch:** `feat/cowork` (from `asmg/main`) · **Status:** approved design
**Why:** the Claude desktop app's Cowork sessions — interactive work and scheduled routines — live in a
store no adapter reads, so none of them appear on the map. Assessed in the audit as feasible (effort M)
with three hazards: volume (hundreds of scheduled runs), scan cost (records up to ~1.8 MB), and
sensitive files beside the records.

## Decisions (approved)

| Topic | Decision |
|---|---|
| Shape | A new adapter `server/harnesses/claude-cowork.mjs` (`id: 'claude-cowork'`, `name: 'Claude Cowork'`), registered in `server/harnesses/index.mjs` after `claudeCode`. No change to `scan.mjs`, `api.mjs` or `src/`. Not folded into `claude-code.mjs`: two stores with different shapes in one file. |
| Store | `<Claude app data>/local-agent-mode-sessions/<account>/<org>/` — app data is `~/Library/Application Support/Claude` (macOS), `%APPDATA%\Claude` (Windows), `$XDG_CONFIG_HOME/Claude` (Linux). Only account/org folders whose names are UUIDs are entered. `BOT_CROSSING_COWORK_SESSIONS` overrides the store root (tests, relocated installs). |
| What appears | **Interactive** sessions (no `scheduledTaskId`, `sessionType !== 'scheduled'`) whose `lastActivityAt` is within the last **30 days**: one thread each. **Enabled routines** (`enabled: true` in `scheduled-tasks.json`): one thread per routine, id `claude-cowork:task:<orgId>:<taskId>`, built from its runs inside the same 30-day window — title, error, size, model and liveness from the latest run, `createdAt` from the earliest. Runs of disabled routines, and routines with no run in the window, do not appear. |
| Placement | The first entry of `userSelectedFolders` (the run's, else the routine's in `scheduled-tasks.json`) that is an existing directory: `project` = its basename, `projectPath` = `cwd` = that folder — so a Cowork astronaut shares the zone of any Claude Code thread in the same folder. None → `project: 'Cowork'`, `projectPath: ''`, `cwd: ''` (one shared zone; the HUD greys its folder buttons). |
| Read surface (pinned) | Exactly: the org folder's listing; `local_<uuid>.json` records (stat every poll; parse only those modified in the window); `scheduled-tasks.json`; per session `<sessionDir>/.claude/projects/*/<cliSessionId>.jsonl` (stat for size and mtime — found by listing one level, never by decoding the folder name); `<sessionDir>/.claude/sessions/*.json` (liveness). **Never opened:** `.credentials.json`, `.audit-key`, `.claude.json`, `cowork_*.json`, `audit.jsonl`, anything in `outputs/` or `uploads/`, `spaces.json`, `artifacts.json`. |
| Field whitelist | After `JSON.parse`, a record is reduced to `sessionId, cliSessionId, title, createdAt, lastActivityAt, model, isArchived, isStarred, userSelectedFolders, scheduledTaskId, sessionType, hasError (Boolean(error)), hostLoopMode`; nothing else is kept or cached — system prompts, MCP configs, account names and email addresses are dropped at parse. |
| Cost | Parsed records are cached against `(mtime, size)`; a record whose mtime is older than the window is never parsed (its `lastActivityAt` cannot be newer than its mtime). Records are parsed one at a time. Today: ~1150 stats per poll, ~224 parses once at start. |
| Thread fields | `lastActivityAt` = the record's (for a routine, its latest run's); `sizeBytes` = transcript bytes (0 if none); `hasError`, `archived` (`isArchived === true`), `starred`, `model` from the record; `routine` = task id or `''`; `unread: false` and `lastFocusedAt: 0` (Cowork keeps no focus history — unknowable, not true); `source: 'cowork'`; `worktree`, `gitBranch`, `effort`, `prState`, `preview` empty. |
| Running | Live only if the session's registry names a pid on this machine (`pidDomain` equal to `process.platform`, record `hostLoopMode === true`) that `kill(pid, 0)` accepts or answers EPERM, **and** the transcript moved in the last 30 minutes. A registry without `pidDomain` is not probed. |
| Open / New | `canOpen: false`; `openThread` returns `{ ok: false, error }` saying to open it from the Cowork sidebar — no verified deep link to an existing Cowork session exists. `newSession(dir)` → `claude://cowork/new?folder=${encodeURIComponent(dir)}` (the app's own "send to Cowork" quick action form). |
| Hard rules | Read-only; nothing read or run inside an app bundle; no new dependencies; ids prefixed `claude-cowork:`. |

## Testing

Synthetic fixture store via `BOT_CROSSING_COWORK_SESSIONS` (this fork is public — nothing from the real
store). Cases: interactive window; routine collapse and the enabled filter; placement by first existing
folder with the `Cowork` fallback; the whitelist (a fixture record carrying a system prompt and an
email address yields a thread with neither anywhere in it); the pinned read surface, tested the only way
that can fail — a fixture `.credentials.json` / `.audit-key` / `audit.jsonl` whose content is a unique
marker string, and a sub-process-free check that no marker appears in anything `scanThreads` returns
(the per-file "never opened" list is otherwise enforced by review); errors; liveness; prefixed ids;
`canOpen` false; the new-session URL. Plus the harness-contract test already iterates
every registered harness.

## After the adapter: tidying the map (an operation, not code)

With Cowork on the map, list candidates — threads whose folder or worktree no longer exists, errored
dead ends, repos that are gone or superseded — and, after the user approves the list, archive threads
and hide repos **through Bot Crossing's own colony state only** (reversible; nothing in Claude's data is
touched).
