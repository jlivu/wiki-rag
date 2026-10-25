/**
 * A durable queue, one row per page.
 *
 * The primary key is the page id, so a second save of the same page updates
 * the existing row and pushes its deadline out instead of adding work: rapid
 * saves collapse into one job.
 */
import type { Pool } from 'pg'

export type PageEvent = 'created' | 'updated' | 'deleted' | 'renamed'

export interface QueuedJob {
  pageId: number
  event: PageEvent
  path: string | null
  locale: string | null
  attempts: number
}

/** A job claimed by a worker is left alone for this long before retrying. */
const LOCK_MINUTES = 5
const MAX_ATTEMPTS = 5

export async function enqueue (
  db: Pool,
  job: { pageId: number, event: PageEvent, path?: string | null, locale?: string | null },
  debounceSeconds: number
): Promise<void> {
  await db.query(`
    INSERT INTO index_queue (page_id, event, path, locale, run_after)
    VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
    ON CONFLICT (page_id) DO UPDATE SET
      event      = EXCLUDED.event,
      path       = COALESCE(EXCLUDED.path, index_queue.path),
      locale     = COALESCE(EXCLUDED.locale, index_queue.locale),
      run_after  = EXCLUDED.run_after,
      attempts   = 0,
      last_error = NULL,
      locked_at  = NULL,
      updated_at = now()
  `, [job.pageId, job.event, job.path ?? null, job.locale ?? null, debounceSeconds])
}

/**
 * Queue a page without disturbing one already waiting. Reconciliation and
 * re-index-everything use this, so they cannot pull a debounced save
 * forward into the middle of someone's editing session.
 */
export async function enqueueIfAbsent (
  db: Pool,
  job: { pageId: number, event: PageEvent, path?: string | null, locale?: string | null }
): Promise<void> {
  await db.query(`
    INSERT INTO index_queue (page_id, event, path, locale, run_after)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (page_id) DO NOTHING
  `, [job.pageId, job.event, job.path ?? null, job.locale ?? null])
}

/** Take the next job that is due, if any. */
export async function claim (db: Pool): Promise<QueuedJob | null> {
  const { rows } = await db.query<{
    page_id: number, event: PageEvent, path: string | null, locale: string | null, attempts: number
  }>(`
    UPDATE index_queue SET locked_at = now(), updated_at = now()
    WHERE page_id = (
      SELECT page_id FROM index_queue
      WHERE run_after <= now()
        AND (locked_at IS NULL OR locked_at < now() - make_interval(mins => $1))
      ORDER BY run_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING page_id, event, path, locale, attempts
  `, [LOCK_MINUTES])

  const row = rows[0]
  return row
    ? { pageId: row.page_id, event: row.event, path: row.path, locale: row.locale, attempts: row.attempts }
    : null
}

export async function complete (db: Pool, pageId: number): Promise<void> {
  await db.query('DELETE FROM index_queue WHERE page_id = $1', [pageId])
}

/** Back off and try again, or give up after a few attempts. */
export async function fail (db: Pool, job: QueuedJob, reason: string): Promise<{ dropped: boolean }> {
  const attempts = job.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    await db.query('DELETE FROM index_queue WHERE page_id = $1', [job.pageId])
    return { dropped: true }
  }
  await db.query(`
    UPDATE index_queue SET
      attempts   = $2,
      last_error = $3,
      locked_at  = NULL,
      run_after  = now() + make_interval(secs => $4),
      updated_at = now()
    WHERE page_id = $1
  `, [job.pageId, attempts, reason.slice(0, 500), 30 * attempts])
  return { dropped: false }
}

export async function queueDepth (db: Pool): Promise<number> {
  const { rows } = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM index_queue')
  return Number(rows[0]?.count ?? 0)
}
