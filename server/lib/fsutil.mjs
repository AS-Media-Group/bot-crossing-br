/**
 * Filesystem helpers shared by every harness adapter.
 *
 * Nothing in here knows about a particular harness — an adapter is free to ignore the lot
 * and read its data however it likes. See `server/harnesses/README.md` for the contract.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Read the first chunk of a file without pulling a 12MB transcript into memory. */
export async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    // Drop a trailing partial line so JSON.parse never sees half a record.
    return bytesRead === bytes ? text.slice(0, text.lastIndexOf('\n') + 1) : text
  } finally {
    await fh.close()
  }
}

/**
 * The last `bytes` of a file, with a leading partial line dropped. The mirror of `readHead`,
 * for the questions only the end of a transcript answers — whose turn it is right now.
 */
export async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const want = Math.min(bytes, size)
    const buf = Buffer.allocUnsafe(want)
    const { bytesRead } = await fh.read(buf, 0, want, size - want)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    return want === size ? text : text.slice(text.indexOf('\n') + 1)
  } finally {
    await fh.close()
  }
}

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

/** Parse a JSONL blob, skipping the partial or malformed lines a live file always has. */
export function jsonLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* partial or malformed line — skip */
    }
  }
  return out
}

export async function listFiles(dir, filter) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((e) => e.isFile() && filter(e.name)).map((e) => path.join(dir, e.name))
}

export async function listDirs(dir) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/** Does this path exist at all? Adapters use it to answer `detect()`. */
export async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Where an executable is, as an absolute path, or null. PATH first, then `extraDirs` — the
 * places an installer puts a binary that a server started with a thin PATH (an IDE launcher, a
 * service unit) would not see. Candidates are resolved rather than joined: the caller may spawn
 * from a different working directory than this check ran in, and a relative PATH entry would
 * then name two different files. X_OK alone passes for a directory, hence the stat.
 *
 * It never looks inside an application bundle, and no caller should hand it a path that does.
 * Running a binary out of somebody else's `.app` is how you get the OS blaming us for it.
 */
export async function findExecutable(name, extraDirs = []) {
  if (typeof name !== 'string' || !name) return null
  const explicit = name.includes('/') || name.includes(path.sep)
  const onPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of explicit ? ['.'] : [...onPath, ...extraDirs]) {
    const candidate = path.resolve(dir, name)
    try {
      await fsp.access(candidate, fsp.constants.X_OK)
      if ((await fsp.stat(candidate)).isFile()) return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

export const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
