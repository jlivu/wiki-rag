/**
 * POST /ai/api/agent — one AG-UI run, streamed back as server-sent events.
 */
import { EventType, type BaseEvent } from '@ag-ui/core'
import { RunAgentInputSchema } from '@ag-ui/core/schemas'
import { EventEncoder } from '@ag-ui/encoder'
import type { FastifyPluginAsync } from 'fastify'

import { runMockAgent } from '../agent/mock-agent.js'
import { AGENT_PATH, readForwardedPage } from '../../shared/index.js'

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.post(AGENT_PATH, async (request, reply) => {
    // Fastify stops managing the response; the events are written by hand.
    reply.hijack()
    const res = reply.raw

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Belt and braces: the dev proxy already streams without buffering.
      'X-Accel-Buffering': 'no'
    })

    // The response, not the request: a request stream is 'close'd as soon as
    // its body has been read, which is before the first event is written.
    let aborted = false
    res.on('close', () => { aborted = true })

    const encoder = new EventEncoder()
    const emit = (event: BaseEvent) => {
      if (aborted || res.writableEnded || res.destroyed) { return }
      res.write(encoder.encodeSSE(event))
    }

    try {
      const input = RunAgentInputSchema.safeParse(request.body)
      if (!input.success) {
        request.log.warn({ issues: input.error.issues }, 'rejected an agent run')
        emit({
          type: EventType.RUN_ERROR,
          message: 'The run could not be read. Expected an AG-UI RunAgentInput body.',
          code: 'INVALID_INPUT'
        })
        return
      }

      const page = readForwardedPage(input.data.forwardedProps)

      await runMockAgent({
        input: input.data,
        page,
        emit,
        isAborted: () => aborted
      })
    } catch (err) {
      request.log.error({ err }, 'the agent run failed')
      emit({
        type: EventType.RUN_ERROR,
        message: 'The assistant could not finish this answer.',
        code: 'AGENT_FAILED'
      })
    } finally {
      if (!res.writableEnded) { res.end() }
    }
  })
}
