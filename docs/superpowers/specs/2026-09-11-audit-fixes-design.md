# Audit fixes: accurate map, locked-down server, safe colony file

**Date:** 2026-09-11 · **Branch:** `asmg/main` (fork patch branch; `main` mirrors upstream)
**Source:** a read-only, adversarially verified audit of this fork against a real macOS machine
(Claude Code desktop + CLI, a repo on an external volume whose name ends in a space). 49 findings,
none refuted. This spec covers the three bundles chosen for implementation. A Cowork adapter was
assessed and deliberately left out.

---

## A. The map tells the truth (`server/harnesses/claude-code.mjs`, `server/lib/fsutil.mjs`)

| # | Defect | Decision |
|---|---|---|
| A1 | A transcript whose **first record is larger than the 192 KB head** (an SDK session with a pasted document writes the prompt twice before any `cwd`) yields an empty head; the thread then falls back to `decodeProjectDir`, which turns every `-` into `/` and invents a folder — a bogus zone named after its last fragment. | Read forward with a partial-line carry until the first `cwd` (bounded at 2 MB, cached per session id once found). Replace `decodeProjectDir` with a resolver that only **checks** candidates: a path is accepted only if `path.replace(/[^a-zA-Z0-9]/g, '-') === folderName`. Candidates are paths the machine already reported (other transcripts' `cwd`, desktop records' `cwd`/`originCwd`, `relocatedCwd`), plus one constructed case: `<known repo>` + `--claude-worktrees-<name>`. Nothing found → `''` (HUD greys the folder buttons). |
| A2 | Once A1 lands, an uncapped `firstPrompt` would become a 175k-char title in every poll. | Cap `firstPrompt` at 300 chars. |
| A3 | Records written before the desktop app kept `lastFocusedAt` lack the key; absence read as "never opened", so months-old threads all wave `?`. | Absent key → unread only if activity is < 3 days old (the dormancy threshold). Present key → unchanged rule. |
| A4 | `lastActivityAt` uses transcript **mtime**, which the app bumps with bulk untimestamped bookkeeping writes long after a conversation ends. | Use the last **timestamped** record in the 64 KB tail (cached by mtime); mtime only when the tail has none. |
| A5 | Titles and branches written past the head are missed; relocated worktree sessions report the repo root. | The tail supplies the latest `customTitle`, `aiTitle`, `gitBranch`, `relocatedCwd`. A CLI-only thread's cwd is whichever reported cwd encodes to its folder name (relocated first). |
| A6 | Duplicate astronauts: transcripts the desktop app copied (fork/import) or superseded show as separate CLI-only threads. | Fold a CLI-only transcript when (a) its last user/assistant record belongs to another session whose transcript exists (a copy), or (b) it shares its root message uuid with a non-fork desktop thread created within 60 s of its first record, and did nothing after that thread's last activity (a superseded original). Anything that continued later stays. |
| A7 | A live session running background subagents/workflows reads "waiting" (`?`) because only the parent transcript is inspected, and "waiting" ignores the desktop focus stamp. | For live threads, the newest mtime under `<project>/<session>/subagents/**` counts: written in the last 2 min → working. "Waiting" makes a thread unread only if it handed back after you last focused it. |
| A8 | `kill(pid, 0)` throwing EPERM is read as "process gone". | EPERM → alive (running still also requires a fresh transcript). |

## B. The server answers only its own page, and only about its own folders

| # | Defect | Decision |
|---|---|---|
| B1 | Origin is compared by **hostname only**, and Vite's dev CORS reflects any localhost origin — any other page on localhost (another dev server, a local WordPress, Jupyter) can read every thread title, prompt and path, and POST. LAN IPs are trusted even when bound to loopback. | Origin must equal Host exactly (`new URL(origin).host === new URL('http://' + host).host`). Refuse `Sec-Fetch-Site` other than `same-origin`/`none`. Trust LAN IPv4s only when `BOT_CROSSING_HOST` is non-loopback. `server.cors: false`. |
| B2 | `/api/reveal` and `/api/new-session` act on **any** existing directory — including `.app` bundles, which `open` launches. | Allowlist: the resolved `projectPath`/`cwd` of every scanned thread, refreshed each poll, one re-scan on a miss. Same check on the Linux terminal-resume `cwd`. `open -R` was considered and not adopted (UX change; the allowlist closes the hole). |
| B3 | Vite's `/__open-in-editor` answers a cross-site GET. Vite serves repo files outside `/api` (`data/colony.json`, `.claude/*`). | Plugin middleware 404s the editor route. `server.fs = { strict, allow: [repo], deny: [defaults…, '**/data/colony.json*', '**/.claude/**'] }` — patterns containing `/` must be globstar-anchored or Vite ignores them. Corrected post-review: `**/.claude/**` matches an *ancestor* named `.claude`, which 403s the whole app inside a Claude Code worktree (`<repo>/.claude/worktrees/<name>/`). The `.claude` pattern is anchored at this checkout instead: `` `${root.split(path.sep).join('/').replace(/[()[\]{}!*?+@]/g, '\\$&')}/.claude/**` ``. |
| B4 | New conversation encodes spaces as `+` (`URLSearchParams`); the Claude app's own Finder quick action uses `encodeURIComponent` (`%20`). | `claude://code/new?folder=${encodeURIComponent(dir)}`; same for `codex://threads/new?path=`. |
| B5 | `npm run serve`: a malformed `%` escape crashes the process; static routes skip the Host check; `EADDRINUSE` is an unhandled crash. | Handler never throws (400 / 500), Host check on every route, `server.on('error')` with a clear message. Export `handler`; listen only when run as the entry point. |

## C. The colony file survives a bad disk (`server/api.mjs`, `src/game/api.js`)

| # | Defect | Decision |
|---|---|---|
| C1 | A failed colony write escapes the `try` (`return serialise(...)` un-awaited) and kills the whole server. | `return await serialise(...)`. |
| C2 | An unreadable or corrupt `colony.json` is served as an **empty** colony and the next save overwrites it — archives, layout and hidden repos lost. | `readState` returns the empty state only on `ENOENT`; anything else is `StorageUnavailable` → 503, file untouched. PUT with a base but no file → 503. PUT with base 0 against a real file → 409 (merge, never overwrite). `mkdir` of the data folder is non-recursive (a vanished drive fails loudly). Thread listing survives an unreadable file. Client refuses to merge a 409 carrying an unversioned colony while it holds a versioned one. **Rejected:** `colony.bak.json` / `colony.corrupt-<ts>.json` — they widen what the project writes (DECISIONS.md). |

## Global constraints (every change)

- Nothing is written anywhere except `data/colony.json` (or `$BOT_CROSSING_DATA/colony.json`). Nothing is read from or executed inside an application bundle. No directory listing outside what the adapters already read.
- Runtime dependencies stay exactly `three` and `@mdi/js`. No new devDependencies.
- Node ≥ 22.13 (`engines`). `fs.readdir({ recursive: true })` and `Dirent.parentPath` are fine.
- House style: no semicolons, single quotes, 2-space indent, ~110 columns; comments explain *why*, especially why an obvious approach was rejected.
- New tests never bind a socket (use `test/support/inject.mjs`) and never read the real machine (fixture homes / empty `HOME`). Fixtures are synthetic — this fork is public.
