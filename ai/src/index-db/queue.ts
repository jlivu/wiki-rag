/**
 * A durable queue, one row per indexable thing.
 *
 * The primary key is the kind and the id, so a second save of the same page
 * — or a second upload of the same file — updates the existing row and
 * pushes its deadline out instead of adding work: rapid changes collapse
 * into one job. Pages and documents are numbered by different Wiki.js
 * tables, so the kind is part of the key: asset 5 and page 5 are not the
 * same job. A video is numbered by this index rather than by the wiki,
 * because it lives in a folder on the Mac and the wiki knows nothing
 * about it.
 */
import type { Pool } from 'pg'

export type IndexEvent = 'created' | 'updated' | 'deleted' | 'renamed'
export type IndexKind = 'page' | 'document' | 'video'

export interface QueuedJob {
  kind: IndexKind
  entityId: number
  event: IndexEvent
  path: string | null
  locale: string | null
  attempts: number
}

export interface JobRequest {
  kind: IndexKind
  entityId: number
  event: IndexEvent
  path?: string | null
  locale?: string | null
}

/** A job claimed by a worker is left alone for this long before retrying. */
const LOCK_MINUTES = 5
const MAX_ATTEMPTS = 5

export async function enqueue (
  db: Pool,
  job: JobRequest,
  debounceSeconds: number
): Promise<void> {
  await db.query(`
    INSERT INTO index_queue (kind, entity_id, event, path, locale, run_after)
    VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
    ON CONFLICT (kind, entity_id) DO UPDATE SET
      event      = EXCLUDED.event,
      path       = COALESCE(EXCLUDED.path, index_queue.path),
      locale     = COALESCE(EXCLUDED.locale, index_queue.locale),
      run_after  = EXCLUDED.run_after,
      attempts   = 0,
      last_error = NULL,
      locked_at  = NULL,
      updated_at = now()
  `, [job.kind, job.entityId, job.event, job.path ?? null, job.locale ?? null, debounceSeconds])
}

/**
 * Queue something without disturbing a job already waiting. Reconciliation
 * and re-index-everything use this, so they cannot pull a debounced save
 * forward into the middle of someone's editing session.
 */
export async function enqueueIfAbsent (db: Pool, job: JobRequest): Promise<void> {
  await db.query(`
    INSERT INTO index_queue (kind, entity_id, event, path, locale, run_after)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (kind, entity_id) DO NOTHING
  `, [job.kind, job.entityId, job.event, job.path ?? null, job.locale ?? null])
}

/** Take the next job that is due, if any. */
export async function claim (db: Pool): Promise<QueuedJob | null> {
  const { rows } = await db.query<{
    kind: IndexKind, entity_id: number, event: IndexEvent,
    path: string | null, locale: string | null, attempts: number
  }>(`
    UPDATE index_queue SET locked_at = now(), updated_at = now()
    WHERE (kind, entity_id) = (
      SELECT kind, entity_id FROM index_queue
      WHERE run_after <= now()
        AND (locked_at IS NULL OR locked_at < now() - make_interval(mins => $1))
      ORDER BY run_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING kind, entity_id, event, path, locale, attempts
  `, [LOCK_MINUTES])

  const row = rows[0]
  return row
    ? {
        kind: row.kind,
        entityId: row.entity_id,
        event: row.event,
        path: row.path,
        locale: row.locale,
        attempts: row.attempts
      }
    : null
}

export async function complete (db: Pool, job: QueuedJob): Promise<void> {
  await db.query('DELETE FROM index_queue WHERE kind = $1 AND entity_id = $2', [job.kind, job.entityId])
}

/** Back off and try again, or give up after a few attempts. */
export async function fail (db: Pool, job: QueuedJob, reason: string): Promise<{ dropped: boolean }> {
  const attempts = job.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    await db.query('DELETE FROM index_queue WHERE kind = $1 AND entity_id = $2', [job.kind, job.entityId])
    return { dropped: true }
  }
  await db.query(`
    UPDATE index_queue SET
      attempts   = $3,
      last_error = $4,
      locked_at  = NULL,
      run_after  = now() + make_interval(secs => $5),
      updated_at = now()
    WHERE kind = $1 AND entity_id = $2
  `, [job.kind, job.entityId, attempts, reason.slice(0, 500), 30 * attempts])
  return { dropped: false }
}

/**
 * Put a job back without counting it as an attempt.
 *
 * For a failure that is nothing to do with the job: the embedding
 * service being down is the case this exists for. Counting those would
 * drop the work after five tries during an outage that is going to end,
 * and the page would then only come back on the next reconciliation.
 */
export async function retryLater (
  db: Pool,
  job: QueuedJob,
  reason: string,
  seconds: number
): Promise<void> {
  await db.query(`
    UPDATE index_queue SET
      last_error = $3,
      locked_at  = NULL,
      run_after  = now() + make_interval(secs => $4),
      updated_at = now()
    WHERE kind = $1 AND entity_id = $2
  `, [job.kind, job.entityId, reason.slice(0, 500), seconds])
}

export async function queueDepth (db: Pool): Promise<number> {
  const { rows } = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM index_queue')
  return Number(rows[0]?.count ?? 0)
}
