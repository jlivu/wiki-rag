/**
 * Self-healing: what to do when the index names something the wiki does
 * not have.
 *
 * Every result is checked against Wiki.js as the reader who asked, and
 * that check can come back two different ways. "You may not see this" is
 * the reader's business and the result is simply dropped. "There is no
 * such thing" is the index's business: the page or file has gone and
 * something derived from it is still being offered, which is exactly
 * what must never happen.
 *
 * Nothing is deleted on the strength of one reader's 404. The page or
 * file is queued instead, and the indexer reads it again with the admin
 * key: gone means gone and the row goes, and a page that has merely been
 * moved has its path corrected rather than being thrown away.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'

import { enqueueIfAbsent } from '../index-db/queue.js'

export async function forgetStalePage (
  db: Pool,
  pageId: number,
  path: string,
  locale: string,
  log?: FastifyBaseLogger
): Promise<void> {
  await enqueueIfAbsent(db, { kind: 'page', entityId: pageId, event: 'updated', path, locale })
  log?.warn({ pageId, path, locale }, 'a search result is no longer in the wiki; dropped and queued for re-checking')
}

export async function forgetStaleDocument (
  db: Pool,
  documentId: number,
  path: string,
  log?: FastifyBaseLogger
): Promise<void> {
  await enqueueIfAbsent(db, { kind: 'document', entityId: documentId, event: 'updated', path })
  log?.warn({ documentId, path }, 'a search result is no longer in the wiki; dropped and queued for re-checking')
}
