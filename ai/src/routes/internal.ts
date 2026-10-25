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
import type { IndexEvent } from '../index-db/queue.js'

export const INTERNAL_PREFIX = '/internal'

const EVENTS: readonly IndexEvent[] = ['created', 'updated', 'deleted', 'renamed']
/** What Wiki.js calls its asset hooks, mapped onto the queue's events. */
const ASSET_EVENTS: Record<string, IndexEvent> = {
  uploaded: 'updated',
  renamed: 'renamed',
  deleted: 'deleted'
}

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

      if (!EVENTS.includes(event as IndexEvent) || !Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ ok: false, error: 'expected { event, id, path, locale }' })
      }
      if (!indexer.enabled) {
        // Accepted and dropped: the wiki must not care either way.
        return reply.code(202).send({ ok: true, queued: false, reason: 'the indexer is off' })
      }

      await indexer.enqueuePageEvent({
        event: event as IndexEvent,
        id,
        path: typeof body.path === 'string' ? body.path : null,
        locale: typeof body.locale === 'string' ? body.locale : null
      })
      return reply.code(202).send({ ok: true, queued: true })
    })

    /**
     * A file was uploaded, renamed or deleted in the asset manager.
     *
     * A rename sends the new path; the job re-reads the asset anyway, so
     * the path here is only for the log and for an event that arrives
     * before the file is visible to a listing.
     */
    app.post(`${INTERNAL_PREFIX}/asset-event`, async (request, reply) => {
      const body = (request.body ?? {}) as PageEventBody
      const name = typeof body.event === 'string' ? body.event : ''
      const event = ASSET_EVENTS[name]
      const id = Number(body.id)

      if (!event || !Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ ok: false, error: 'expected { event: uploaded|renamed|deleted, id, path }' })
      }
      if (!indexer.enabled) {
        return reply.code(202).send({ ok: true, queued: false, reason: 'the indexer is off' })
      }

      await indexer.enqueueAssetEvent({
        event,
        id,
        path: typeof body.path === 'string' ? body.path : null
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

    /**
     * What the index holds, measured against the wiki.
     *
     * `?compare=0` reports the index's own counts without asking Wiki.js
     * for its page list and walking its asset folders.
     */
    app.get(`${INTERNAL_PREFIX}/status`, async (request) => {
      const query = (request.query ?? {}) as { compare?: string }
      const compare = query.compare !== '0' && query.compare !== 'false'
      return await indexer.report(compare)
    })

    /** Admin > Storage > Index status, which logs the summary line. */
    app.post(`${INTERNAL_PREFIX}/status`, async (_request, reply) => {
      const report = await indexer.report(true)
      return reply.send({ ok: true, summary: summarise(report), report })
    })
  }
}

/** One line an administrator can read in the wiki's own log. */
function summarise (report: Awaited<ReturnType<Indexer['report']>>): string {
  if (!report.enabled) { return 'the indexer is off' }
  const wiki = report.wiki
    ? `the wiki has ${report.wiki.pages} page(s) and ${report.wiki.files} file(s)`
    : 'the wiki could not be asked what it holds'
  const index = `the index has ${report.index.pages} page(s), ${report.index.documents} file(s) ` +
    `and ${report.index.chunks} chunk(s)`
  const last = report.lastReconcile
    ? `last reconciled ${report.lastReconcile.at} (${report.lastReconcile.trigger}` +
      `${report.lastReconcile.ok ? '' : ', which failed'})`
    : 'no reconciliation has run yet'
  const drift = report.drift.note.length > 0 ? `out of step: ${report.drift.note.join('; ')}` : 'in step'
  return `${index}; ${wiki}; ${last}; ${drift}`
}
