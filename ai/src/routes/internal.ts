/**
 * Routes for the wiki itself, not for readers.
 *
 * These live outside the /ai prefix on purpose. The reverse proxy forwards
 * only /ai/* to this service, so nothing here is reachable from the browser
 * on port 3080 — but wiki-app can call it directly on the Docker network at
 * http://ai:4000/internal/...
 */
import type { FastifyPluginAsync } from 'fastify'

import type { Indexer } from '../indexer/indexer.js'
import type { PageEvent } from '../index-db/queue.js'

export const INTERNAL_PREFIX = '/internal'

const EVENTS: readonly PageEvent[] = ['created', 'updated', 'deleted', 'renamed']

interface PageEventBody {
  event?: unknown
  id?: unknown
  path?: unknown
  locale?: unknown
}

export function internalRoutes (indexer: Indexer): FastifyPluginAsync {
  return async (app) => {
    /** A page was created, updated, deleted or renamed. */
    app.post(`${INTERNAL_PREFIX}/page-event`, async (request, reply) => {
      const body = (request.body ?? {}) as PageEventBody
      const event = typeof body.event === 'string' ? body.event : ''
      const id = Number(body.id)

      if (!EVENTS.includes(event as PageEvent) || !Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ ok: false, error: 'expected { event, id, path, locale }' })
      }
      if (!indexer.enabled) {
        // Accepted and dropped: the wiki must not care either way.
        return reply.code(202).send({ ok: true, queued: false, reason: 'the indexer is off' })
      }

      await indexer.enqueuePageEvent({
        event: event as PageEvent,
        id,
        path: typeof body.path === 'string' ? body.path : null,
        locale: typeof body.locale === 'string' ? body.locale : null
      })
      return reply.code(202).send({ ok: true, queued: true })
    })

    /** The storage module's scheduled sync. */
    app.post(`${INTERNAL_PREFIX}/reconcile`, async (_request, reply) => {
      void indexer.reconcile('wiki')
      return reply.code(202).send({ ok: true })
    })

    /** Admin > Storage > Re-index everything. */
    app.post(`${INTERNAL_PREFIX}/reindex`, async (_request, reply) => {
      void indexer.reindexEverything()
      return reply.code(202).send({ ok: true })
    })

    app.get(`${INTERNAL_PREFIX}/status`, async () => {
      return indexer.status()
    })
  }
}
