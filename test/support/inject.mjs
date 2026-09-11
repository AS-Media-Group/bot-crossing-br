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
    // The body is all there is. Without this, IncomingMessage's auto-destroy reads the finished
    // stream as an aborted request and tears the socket down before the response can flush.
    req.complete = true

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
