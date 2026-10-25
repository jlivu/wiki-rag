import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import Fastify from 'fastify'

// A reverse proxy puts this service and the wiki on one origin and sends
// /ai/* here with the path unchanged, so every route keeps the /ai prefix.
const ROUTE_PREFIX = '/ai'

const HOST = process.env.HOST ?? '0.0.0.0'
const PORT = Number(process.env.PORT ?? 4000)

// ../public resolves the same from src/server.ts (tsx) and dist/server.js (tsc).
const PANEL_FILE = fileURLToPath(new URL('../public/panel.html', import.meta.url))

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' }
})

app.get(`${ROUTE_PREFIX}/health`, async () => {
  return { ok: true }
})

// The page the assistant panel loads in its iframe.
app.get(`${ROUTE_PREFIX}/panel`, async (req, reply) => {
  const html = await readFile(PANEL_FILE, 'utf8')
  return reply
    .type('text/html; charset=utf-8')
    // Only the wiki on this same origin may frame the panel.
    .header('content-security-policy', "frame-ancestors 'self'")
    .header('cache-control', 'no-store')
    .send(html)
})

// Let tsx watch and `docker compose` restarts free the port cleanly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  })
}

try {
  await app.listen({ host: HOST, port: PORT })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
