/**
 * POST /ai/api/agent — one AG-UI run, streamed back as server-sent events.
 */
import { EventType, type BaseEvent } from '@ag-ui/core'
import { RunAgentInputSchema } from '@ag-ui/core/schemas'
import { EventEncoder } from '@ag-ui/encoder'
import type { FastifyPluginAsync } from 'fastify'

import { runMockAgent } from '../agent/mock-agent.js'
import { runWikiAgent } from '../agent/wiki-agent.js'
import type { Config } from '../config.js'
import type { Indexer } from '../indexer/indexer.js'
import { createProvider, ProviderError, type ChatProvider } from '../providers/index.js'
import { WikiClient, readWikiToken } from '../wiki/client.js'
import { AGENT_PATH, readForwardedPage } from '../../shared/index.js'

export function agentRoutes (config: Config, indexer: Indexer): FastifyPluginAsync {
  // Built once: the provider holds a client, not per-run state. A bad
  // configuration (a missing key, say) is kept and reported per run rather
  // than stopping the service from starting.
  let provider: ChatProvider | null = null
  let providerError: Error | null = null
  if (config.llm.provider !== 'mock') {
    try {
      provider = createProvider(config)
    } catch (err) {
      providerError = err instanceof Error ? err : new Error(String(err))
    }
  }

  return async (app) => {
    if (providerError) {
      app.log.error({ provider: config.llm.provider, reason: providerError.message }, 'the model provider is not usable')
    }

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
      const abort = new AbortController()
      res.on('close', () => {
        aborted = true
        abort.abort()
      })

      const encoder = new EventEncoder()
      const emit = (event: BaseEvent) => {
        if (aborted || res.writableEnded || res.destroyed) { return }
        res.write(encoder.encodeSSE(event))
      }
      const fail = (code: string, message: string) => {
        emit({ type: EventType.RUN_ERROR, message, code })
      }

      const startedAt = Date.now()
      try {
        const input = RunAgentInputSchema.safeParse(request.body)
        if (!input.success) {
          request.log.warn({ issues: input.error.issues }, 'rejected an agent run')
          fail('INVALID_INPUT', 'The run could not be read. Expected an AG-UI RunAgentInput body.')
          return
        }

        const page = readForwardedPage(input.data.forwardedProps)

        if (config.llm.provider === 'mock') {
          await runMockAgent({ input: input.data, page, emit, isAborted: () => aborted })
          request.log.info({ provider: 'mock', ms: Date.now() - startedAt }, 'agent run finished')
          return
        }

        if (!provider) {
          fail(
            'NOT_CONFIGURED',
            config.llm.provider === 'anthropic' && config.llm.apiKey.length === 0
              ? 'The assistant has no API key yet. Add ANTHROPIC_API_KEY to ai/.env and restart it.'
              : 'The assistant is not configured correctly. Check the service log.'
          )
          return
        }

        // Every wiki read happens as the reader who asked, including the
        // permission check the retriever runs over its own results.
        const token = readWikiToken(request)
        const wiki = new WikiClient(config.wikiUrl, token)

        const stats = await runWikiAgent({
          input: input.data,
          page,
          provider,
          tools: {
            client: wiki,
            token,
            defaultLocale: page?.locale ?? 'en',
            retriever: indexer.retriever,
            log: request.log
          },
          emit,
          isAborted: () => aborted,
          signal: abort.signal,
          maxToolSteps: config.llm.maxToolSteps,
          maxOutputTokens: config.llm.maxOutputTokens
        })

        // Cost and tool use, with no page content and no credentials.
        request.log.info({
          provider: provider.id,
          model: provider.model,
          signedIn: wiki.isAuthenticated,
          ms: Date.now() - startedAt,
          steps: stats.steps,
          stopReason: stats.stopReason,
          toolCalls: stats.toolCalls,
          usage: {
            input: stats.inputTokens,
            output: stats.outputTokens,
            cacheWrite: stats.cacheWriteTokens,
            cacheRead: stats.cacheReadTokens
          }
        }, 'agent run finished')
      } catch (err) {
        if (aborted) { return }
        if (err instanceof ProviderError) {
          request.log.error({ err, code: err.code }, 'the model provider failed')
          fail(err.code, err.message)
        } else {
          request.log.error({ err }, 'the agent run failed')
          fail('AGENT_FAILED', 'The assistant could not finish this answer.')
        }
      } finally {
        if (!res.writableEnded) { res.end() }
      }
    })
  }
}
