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
      // The `.claude` pattern is anchored at this checkout rather than any ancestor: a Claude Code
      // worktree lives *inside* a `.claude/` folder, and `**/.claude/**` there denies every file the
      // app has (index.html, /src/main.js, all of it) — `npm run dev` 403s on its own app.
      deny: [
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/colony.json*',
        `${root.split(path.sep).join('/').replace(/[()[\]{}!*?+@]/g, '\\$&')}/.claude/**`,
      ],
    },
  },
  build: { target: 'esnext' },
})
