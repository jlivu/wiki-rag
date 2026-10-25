import Fastify from 'fastify'

import { agentRoutes } from './routes/agent.js'
import { panelRoutes } from './routes/panel.js'
import { describeConfig, loadConfig } from './config.js'
import { providerLabel } from './providers/index.js'
import { HEALTH_PATH, type HealthResponse } from '../shared/index.js'

// A reverse proxy puts this service and the wiki on one origin and sends
// /ai/* here with the path unchanged, so every route keeps the /ai prefix.
const config = loadConfig()

const app = Fastify({
  logger: { level: config.logLevel }
})

app.log.info(describeConfig(config), 'assistant configuration')

app.get(HEALTH_PATH, async (): Promise<HealthResponse> => {
  return {
    ok: true,
    provider: {
      id: config.llm.provider,
      model: config.llm.model,
      label: providerLabel(config)
    }
  }
})

await app.register(agentRoutes(config))
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
  await app.listen({ host: config.host, port: config.port })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
