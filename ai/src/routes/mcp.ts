/**
 * MCP over Streamable HTTP at /ai/mcp.
 *
 * Stateless: one server and one transport per request, each closing over
 * the API key that made it, so nothing leaks between agents.
 *
 * Origin and Host are checked here rather than through the transport's own
 * options, which the SDK deprecated in favour of external middleware
 * (@modelcontextprotocol/sdk 1.32.2).
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'

import type { Config } from '../config.js'
import type { Indexer } from '../indexer/indexer.js'
import { McpAuth, readBearer } from '../mcp/auth.js'
import { RateLimiter } from '../mcp/rate-limit.js'
import { buildMcpServer, type ToolCallRecord } from '../mcp/server.js'
import { WikiClient } from '../wiki/client.js'
import { MCP_PATH } from '../../shared/index.js'

export function mcpRoutes (config: Config, indexer: Indexer): FastifyPluginAsync {
  const auth = new McpAuth(config.wikiUrl)
  const limiter = new RateLimiter(config.mcp.rateLimitPerMinute)

  return async (app) => {
    /**
     * A browser on another site must not be able to drive this, and a
     * rebound DNS name must not reach it either. An absent Origin is a
     * non-browser caller, which is the normal case for an agent.
     */
    const checkOriginAndHost = (request: FastifyRequest, reply: FastifyReply): boolean => {
      const origin = request.headers.origin
      if (typeof origin === 'string' && origin.length > 0 && !config.mcp.allowedOrigins.includes(origin)) {
        request.log.warn({ origin }, 'mcp: rejected an origin')
        void reply.code(403).send({ error: 'origin not allowed' })
        return false
      }
      const host = request.headers.host
      if (typeof host !== 'string' || !config.mcp.allowedHosts.includes(host)) {
        request.log.warn({ host }, 'mcp: rejected a host')
        void reply.code(403).send({ error: 'host not allowed' })
        return false
      }
      return true
    }

    const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!checkOriginAndHost(request, reply)) { return }

      const token = readBearer(request.headers.authorization)
      if (!token) {
        void reply
          .code(401)
          .header('www-authenticate', 'Bearer realm="wiki"')
          .send({ error: 'a Wiki.js API key is required in the Authorization header' })
        return
      }

      const key = await auth.check(token)
      if (!key.valid) {
        request.log.warn({ key: key.fingerprint }, 'mcp: rejected a key')
        void reply
          .code(401)
          .header('www-authenticate', 'Bearer realm="wiki", error="invalid_token"')
          .send({ error: 'that API key was not accepted by the wiki' })
        return
      }

      const allowance = limiter.take(key.fingerprint)
      if (!allowance.allowed) {
        request.log.warn({ key: key.fingerprint }, 'mcp: rate limited')
        void reply
          .code(429)
          .header('retry-after', String(allowance.retryAfterSeconds))
          .send({ error: `too many calls; try again in ${allowance.retryAfterSeconds}s` })
        return
      }

      // Everything this request reads, it reads as this key.
      const wiki = new WikiClient(config.wikiUrl, token)
      const calls: ToolCallRecord[] = []
      const server = buildMcpServer({
        wiki,
        token,
        retriever: indexer.retriever,
        defaultLocale: config.index.defaultLocale,
        publicUrl: config.wikiPublicUrl
      }, call => {
        calls.push(call)
        // Tool name, who called, how long, how much. No key, no content.
        request.log.info({
          key: key.fingerprint,
          tool: call.tool,
          ms: call.ms,
          chars: call.chars,
          ok: !call.isError
        }, 'mcp tool call')
      })

      const transport = new StreamableHTTPServerTransport({})
      reply.raw.on('close', () => {
        void transport.close()
        void server.close()
      })

      // Fastify stops managing the response; the transport writes it.
      reply.hijack()
      await server.connect(transport)
      await transport.handleRequest(request.raw, reply.raw, request.body)
    }

    app.post(MCP_PATH, handle)
    app.get(MCP_PATH, handle)
    app.delete(MCP_PATH, handle)
  }
}
