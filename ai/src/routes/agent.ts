/**
 * POST /ai/api/agent — one AG-UI run, streamed back as server-sent events.
 */
import { EventType, type BaseEvent } from '@ag-ui/core'
import { RunAgentInputSchema } from '@ag-ui/core/schemas'
import { EventEncoder } from '@ag-ui/encoder'
import type { FastifyPluginAsync } from 'fastify'

import { runMockAgent } from '../agent/mock-agent.js'
import { SourceRegistry } from '../agent/sources.js'
import { runWikiAgent } from '../agent/wiki-agent.js'
import type { Config } from '../config.js'
import type { Indexer } from '../indexer/indexer.js'
import { ProviderError, ProviderPool } from '../providers/index.js'
import { WikiClient, readWikiToken } from '../wiki/client.js'
import {
  AGENT_PATH, readForwardedEffort, readForwardedModel, readForwardedPage
} from '../../shared/index.js'

export function agentRoutes (config: Config, indexer: Indexer): FastifyPluginAsync {
  // One provider per allowlisted model, built on first use and kept: a
  // provider holds an HTTP client and no per-run state. A model that
  // cannot be built — Anthropic with no key — fails for that run rather
  // than stopping the service from starting.
  const providers = new ProviderPool(config.llm)

  return async (app) => {
    app.log.info({
      models: providers.choices.map(choice => choice.id),
      default: providers.defaultChoice.id
    }, 'models a reader may pick')

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

        // The browser sends an id, never a model name. Anything not on
        // the server's own list is refused outright: a run must never be
        // able to name a model the administrator did not allow.
        const wanted = readForwardedModel(input.data.forwardedProps)
        const choice = wanted === undefined ? providers.defaultChoice : providers.find(wanted)
        if (!choice) {
          request.log.warn({ wanted }, 'rejected a run: that model is not on the list')
          fail('UNKNOWN_MODEL', 'That model is not available here. Pick another one under the message box.')
          return
        }

        // Same rule for the effort: anything this model does not offer —
        // including a level that is not a level at all — is refused
        // rather than quietly rounded to one it does.
        const asked = readForwardedEffort(input.data.forwardedProps)
        const unsupported = asked.kind === 'level' &&
          !choice.efforts.some(level => level.id === asked.level)
        if (asked.kind === 'unknown' || unsupported) {
          request.log.warn(
            { model: choice.id, asked: asked.kind },
            'rejected a run: that effort is not supported'
          )
          fail('UNKNOWN_EFFORT', `${choice.label} does not offer that effort level.`)
          return
        }
        const effort = asked.kind === 'level'
          ? asked.level
          : choice.defaultEffort ?? config.llm.effort

        if (config.llm.provider === 'mock') {
          await runMockAgent({ input: input.data, page, emit, isAborted: () => aborted })
          request.log.info({ provider: 'mock', ms: Date.now() - startedAt }, 'agent run finished')
          return
        }

        let provider
        try {
          provider = providers.get(choice)
        } catch (err) {
          const reason = err instanceof ProviderError ? err.message : 'The assistant is not configured correctly.'
          request.log.error({ err, model: choice.id }, 'that model could not be started')
          fail('NOT_CONFIGURED', `${choice.label} cannot answer: ${reason}`)
          return
        }
        if (!provider) {
          fail('NOT_CONFIGURED', 'The assistant is not configured correctly. Check the service log.')
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
            index: indexer.database,
            // One registry per run: it hands out the S1, S2 ids and turns
            // them back into links from what the tools returned.
            sources: new SourceRegistry(config.wikiPublicUrl),
            log: request.log
          },
          emit,
          isAborted: () => aborted,
          signal: abort.signal,
          maxToolSteps: config.llm.maxToolSteps,
          // Local models only. A cloud model keeps the loop whatever
          // this setting says: it is a crutch for a small model, not a
          // change of behaviour for every model.
          retrieveFirst: provider.id === 'ollama' && config.llm.ollamaRetrieveFirst,
          maxOutputTokens: config.llm.maxOutputTokens,
          effort
        })

        // Cost and tool use, with no page content and no credentials.
        request.log.info({
          provider: provider.id,
          model: provider.model,
          effort,
          // Whether the reader chose these or took what they were given.
          modelChosen: wanted !== undefined,
          effortChosen: asked.kind === 'level',
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
