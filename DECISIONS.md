# Decisions

Things that are settled, and why. If a PR argues with one of these, the PR is not wrong — but
it needs to argue with the reason rather than work around it.

Written down because the same questions kept arriving one PR at a time, and answering them
per-PR was producing a codebase with three answers to each.

## Bot Crossing never writes to a harness

`data/colony.json` is the only file this project writes, anywhere.

It used to write one flag — `isArchived` on Claude Code's own session record. That write landed
on disk, and still looked broken: the desktop app serves from the copy of its records it loaded
at launch, so a thread you archived here stayed put in its own list until the app restarted, and
the app rewrote the record from memory the next time it touched the thread. Holding that
together took a re-assert on every scan, a `ps` sweep to guess whether the app had re-read the
file, and a *pending* state for the gap between them.

So archiving is the colony's own bookkeeping now. The astronaut walks back to the ship exactly
as before, and archiving in the harness's own UI still sends it home too, because the scan reads
that flag. `setArchived` is not part of the adapter interface and adding one back is a bug.

## Nothing is read from or executed inside another application's bundle

Only files under the user's own home directory.

This is not a style preference. An adapter that fell back to
`/Applications/ChatGPT.app/Contents/Resources/codex` and ran it set off a Gatekeeper malware
alert on the maintainer's machine and moved both Codex.app and ChatGPT.app to the Trash —
nothing was wrong with either, but OpenAI's macOS signing certificate had been revoked after the
Axios npm compromise, and macOS's answer to *executing* a binary under a revoked cert is to
block it and bin the app. It also cost five seconds on the first scan while macOS decided.

`claude-code.mjs` used to mention `/Claude.app/Contents/MacOS/Claude`, but that was matching a
string in `ps` output to spot a running process, never launching anything. That code is gone
now anyway; the scan starts no subprocess at all.

## Opening a thread may run a command; nothing else may

Opening is the one place a subprocess is allowed, because there is no other way to hand a
session back on a machine with no desktop app. It goes through a URL the OS resolves, or a
binary the user already has on `PATH` — never a path we guessed inside an app.

## There is one way for an adapter to say "open this"

`openThread(ref)` and `newSession(dir)` return `{ ok, url, command }`, either may be async, and
the server decides what to do with it:

- **macOS and Windows** — the URL goes to the OS opener. A scheme the harness's app registers is
  always answered there, so nothing is probed.
- **Linux** — the scheme is checked with `xdg-mime` first, because `xdg-open` on a scheme nobody
  claims exits quietly and used to reach the page as "Opened". Failing that, `command` runs in a
  terminal. Failing that, the page is told the truth.

`command` is `{ argv, cwd }` with an absolute `argv[0]`. No harness knowledge reaches
`launch()` — that seam is the reason `server/harnesses/` is swappable at all.

## `sizeBytes` is bytes

Every harness has a transcript file; not all of them report tokens, and a CLI-only session
often has no token count at all. The field is a shared log scale across the whole map, so
mixing units would make one harness's buildings taller than another's for the same work.

## Thread ids are prefixed

`claude-code:<uuid>`, `codex:<uuid>`. Two UUIDs will not collide, but the colony keys its
archive list and saved layout on this string, and it is worth being unambiguous rather than
merely lucky. `colony.json` v1 files are migrated on read — only Claude Code ever wrote a bare
id, so the rewrite is unambiguous.

## A harness that cannot read its own store says so

Optional `diagnostic()` on an adapter returns a sentence, or `''`. Without it the failure mode
is a harness that reports `detected: true`, throws inside `scanThreads` on every poll, and looks
perfectly healthy in the HUD while contributing nothing.

## The assistant service is configured, never hardcoded

The Jarvis panel used to speak to exactly one address: `http://127.0.0.1:5281`, baked into
`src/game/jarvis.js`. That was fine while the assistant only ever ran on the same machine, in
the same place, with no auth in front of it. None of that holds once the service runs somewhere
else and needs a bearer token — a constant in client code cannot express "wherever it happens to
be this week," and a token in client code is a token anyone reading the page's source can read.

So the server hands it out instead. `GET /api/assistant` reads `ASSISTANT_URL`,
`ASSISTANT_LOCAL_URL`, `ASSISTANT_TOKEN`, `ASSISTANT_VOICE_URL` and `ASSISTANT_LOCAL_VOICE_URL`
from the environment once, at startup, and answers with the address and token a given request is
allowed to have — behind the same `isLocalRequest` gate as every other route, so the token only
ever reaches this server's own page, on a host this server answers to. The page fetches it once,
keeps the answer in memory for the life of the tab, and never writes it to storage of any kind.
Unset the three assistant variables and the panel falls back to the old `127.0.0.1:5281` path
exactly as before — this changes nothing for an install that has not opted in.

## The voice address has a local/network split too, mirroring the assistant's own

`ASSISTANT_VOICE_URL` used to be one address for every caller, which breaks the moment the page
is reachable both on the machine it runs on and over a network name (a tailnet, say): a plain
loopback `ws://127.0.0.1:…` socket is exactly right for the first case and useless for the
second — unreachable from elsewhere, and blocked outright as mixed content on an `https://` page.

`ASSISTANT_LOCAL_URL` already solved this for the HTTP address, so the voice address gets the
same treatment rather than a different shape: `ASSISTANT_LOCAL_VOICE_URL`, handed back only to a
request whose own `Host` is a loopback name, with `ASSISTANT_VOICE_URL` as the fallback for
everyone else — including a loopback caller when `ASSISTANT_LOCAL_VOICE_URL` is unset, so an
install that has not opted in sees byte-identical behaviour.

## The voice socket's first frame carries the token, when there is one

The legacy voice service only ever checked the page's Origin — the WebSocket's very first frame
has always been a bare `{"type":"hello","v":1}`, with nothing to prove who sent it. That was fine
while the mic could only ever reach a service on the same machine. It stops being fine the moment
the assistant is the configured, reachable-from-elsewhere one `ASSISTANT_URL` already points at:
an Origin check is not an auth check, and a socket cannot send an `Authorization` header the way
an HTTP request can.

So the first frame carries the same bearer token `ASSISTANT_TOKEN` already hands the panel over
HTTP, when one is configured: `{"type":"hello","v":1,"token":"…"}`. The token is read from the
live assistant config at the moment of *connecting* — not once when the page loaded — so a token
issued or rotated after boot is honoured on the very next reconnect, with no reload needed. With
no assistant configured the frame is exactly what it always was, byte for byte, and the legacy
service — which never looks for a `token` field — keeps working unchanged.

A close with WebSocket code `4401` means the token was rejected. The panel does not treat this
like an ordinary drop: retrying the same rejected token every `backoffMs` tier would just get
rejected again, forever, for no benefit. It goes to the existing "voice unavailable" state instead
and stays there — the same restraint already used for `4001` ("another window has the mic") — and
only tries again once the person clicks the orb, exactly as `4001` already waits for that click
before taking the mic back.

## Pull requests are treated as feature requests

Contributions are read closely and their intent is usually implemented directly, rather than
merged branch-by-branch. Nine adapters and fixes arriving at once produced five mutually
incompatible widenings of the same interface; taking the intent and writing one version keeps
the codebase coherent and is faster than negotiating each PR to a common shape.

That means a PR can be closed unmerged and still be the reason something shipped. Where that
happens the commit says so and the contributor is credited by name. It is a worse deal for
contributors than merging their commit, and it is written down here so nobody has to discover
it from a closed tab.
