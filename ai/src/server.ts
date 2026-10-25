import Fastify from 'fastify'

import { agentRoutes } from './routes/agent.js'
import { panelRoutes } from './routes/panel.js'
import { HEALTH_PATH } from '../shared/index.js'

// A reverse proxy puts this service and the wiki on one origin and sends
// /ai/* here with the path unchanged, so every route keeps the /ai prefix.
const HOST = process.env.HOST ?? '0.0.0.0'
const PORT = Number(process.env.PORT ?? 4000)

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' }
})

app.get(HEALTH_PATH, async () => {
  return { ok: true }
})

await app.register(agentRoutes)
await app.register(panelRoutes)

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
