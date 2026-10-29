// serve.mjs -- a static file server for localhost.
//
// Why it exists: a browser game cannot be driven from a file:// URL. Chrome refuses pointer lock
// there ("The root document of this element is not valid for pointer lock"), and a browser
// Minecraft port takes movement and mouse-look input only once it holds the pointer. Serving the
// same file over http://127.0.0.1 puts it in a secure context, so the page may lock the pointer.
//
//   node serve.mjs [port] [rootDir]
//
// ── Range support is not optional (learned the hard way) ──────────────────────────────────────
// Without `Range` handling the server always answers 200 with the whole file. A media element that
// seeks must re-request a byte range; if it gets 200 instead of 206 it cannot honour the seek and
// silently restarts from 0. Measured: seeking a served audio file over http left the position at
// ~1s (restarted), while the identical file over file:// seeked correctly. The failure is silent —
// the seek command reports success and the position just quietly resets.
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] ?? 8777)
const root = process.argv[3] ?? join(here, '..', 'packs', 'minecraft', 'game')

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.epk': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/** Parse a single-range `bytes=` header. Returns null when absent or not a simple range. */
function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (m === null) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  let start
  let end
  if (rawStart === '') {
    // suffix range: last N bytes
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    // Normalise and confine to the root: a served game must never reach outside its folder.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    const path = join(root, rel === '' ? 'eaglercraft-1.12.html' : rel)
    if (!path.startsWith(root)) { res.writeHead(403).end('forbidden'); return }
    const info = await stat(path)
    if (info.isDirectory()) { res.writeHead(404).end('not found'); return }

    const type = types[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const base = {
      'content-type': type,
      'accept-ranges': 'bytes',
      // Cross-origin isolation is what the WASM build prefers; harmless when unused.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cache-control': 'no-store',
    }

    const range = parseRange(req.headers.range, info.size)
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${info.size}` }).end()
      return
    }
    if (range !== null) {
      // Large media must not be buffered whole: stream just the requested window.
      res.writeHead(206, {
        ...base,
        'content-length': range.end - range.start + 1,
        'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(path, { start: range.start, end: range.end }).pipe(res)
      return
    }

    const body = await readFile(path)
    res.writeHead(200, { ...base, 'content-length': body.length })
    if (req.method === 'HEAD') { res.end(); return }
    res.end(body)
  } catch (e) {
    res.writeHead(404).end('not found: ' + String(e && e.message))
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`serving ${root} at http://127.0.0.1:${port}/\n`)
})
