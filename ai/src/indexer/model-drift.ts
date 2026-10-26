/**
 * Which models produced what is in the index, and what to do when one of
 * them changes.
 *
 * A model's *name* is not its version. `ollama pull nomic-embed-text`
 * can bring down different weights under the same name; a vision model
 * reworded overnight writes different descriptions; a different whisper
 * model hears different words. Each of those silently makes part of the
 * index disagree with what the same question would produce today, and
 * nothing in the content changed, so nothing would ever re-read it.
 *
 * So the index records a fingerprint per model and acts on a change:
 *
 *   embeddings  every vector is meaningless → the whole index is
 *               rebuilt (index-db/migrate.ts, with the digest)
 *   vision      cached descriptions were written by a different model →
 *               they are dropped and whatever used them is re-read
 *   speech      a video's transcript would come out differently →
 *               videos that were transcribed are re-read; ones that
 *               took their words from subtitles are left alone
 *
 * What is detectable differs by provider. Ollama publishes a digest per
 * model, so a re-pull is caught. Anthropic publishes no version beyond
 * the model name, and whisper.cpp's server reports nothing at all about
 * the model it loaded — so for those the fingerprint is *declared*
 * (IMAGE_DESCRIBER_MODEL, STT_MODEL) rather than detected, and changing
 * the setting is how an administrator says "this is a different model
 * now, read it all again".
 *
 * A fingerprint that cannot be read is never treated as a change: a
 * service being down must not cost a re-index.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'

import type { Config } from '../config.js'

import { digestOf } from './embeddings.js'

export interface ModelFingerprints {
  /** 'off', 'anthropic:<model>' or 'ollama:<model>@<digest>'. */
  vision: string
  /** 'off' or 'whispercpp:<model or "unversioned">'. */
  speech: string
}

export interface DriftOutcome {
  /** What changed, in words, for the log and the index status. */
  changes: string[]
  /** Images and videos queued to be read again. */
  requeued: number
  /** Descriptions dropped because a different model would rewrite them. */
  descriptionsDropped: number
}

/**
 * What the current settings amount to.
 *
 * `tags` is Ollama's model list when it could be read, so a local model
 * carries its digest. Without it the Ollama part falls back to the name
 * alone, which is "no new information" rather than "changed".
 */
export function fingerprintsOf (
  config: Config,
  tags: Array<{ name?: string, digest?: string }> | null
): ModelFingerprints {
  const vision = (() => {
    if (config.images.describer === 'off') { return 'off' }
    const model = config.images.describerModel
    if (config.images.describer !== 'ollama') { return `anthropic:${model}` }
    const digest = tags ? digestOf(tags, model) : ''
    return digest.length > 0 ? `ollama:${model}@${digest.slice(0, 16)}` : `ollama:${model}`
  })()

  const speech = config.speech.provider === 'off'
    ? 'off'
    // whisper-server exposes /health and nothing else — no model name,
    // no hash — so this is whatever the administrator declared.
    : `whispercpp:${config.speech.model.length > 0 ? config.speech.model : 'unversioned'}`

  return { vision, speech }
}

/**
 * Compare what is recorded with what is configured, and put right
 * whatever a change invalidated.
 *
 * Called once embeddings are ready, so it runs after the embedding
 * model's own check — which, when it fires, has already emptied
 * everything and made the rest of this moot.
 */
export async function reconcileModels (
  db: Pool,
  config: Config,
  tags: Array<{ name?: string, digest?: string }> | null,
  log: FastifyBaseLogger
): Promise<DriftOutcome> {
  const now = fingerprintsOf(config, tags)
  const { rows } = await db.query<{ vision_model: string, speech_model: string }>(
    'SELECT vision_model, speech_model FROM index_meta WHERE id'
  )
  const before = rows[0]
  const outcome: DriftOutcome = { changes: [], requeued: 0, descriptionsDropped: 0 }

  // No row yet means the embedding set-up has not run; it writes one.
  if (!before) { return outcome }

  // An empty recorded value is a first run, not a change: record it and
  // leave the index alone.
  const changed = (was: string, is: string): boolean => was.length > 0 && was !== is

  if (changed(before.vision_model, now.vision)) {
    const dropped = await db.query(
      'DELETE FROM index_image_descriptions RETURNING content_hash'
    )
    outcome.descriptionsDropped = dropped.rowCount ?? 0
    // Everything that had one has to be read again, with the new model
    // or with none: an image keeps its OCR and its alt text either way.
    const images = await db.query(`
      INSERT INTO index_queue (kind, entity_id, event, path, run_after)
      SELECT 'document', id, 'updated', path, now() FROM index_documents WHERE doc_type = 'image'
      ON CONFLICT (kind, entity_id) DO NOTHING
    `)
    const videos = await db.query(`
      INSERT INTO index_queue (kind, entity_id, event, path, run_after)
      SELECT 'video', v.id, 'updated', v.path, now() FROM index_videos v
      WHERE EXISTS (SELECT 1 FROM index_video_frames f WHERE f.video_id = v.id)
      ON CONFLICT (kind, entity_id) DO NOTHING
    `)
    outcome.requeued += (images.rowCount ?? 0) + (videos.rowCount ?? 0)
    outcome.changes.push(
      `the vision model changed from ${before.vision_model} to ${now.vision}`
    )
  }

  if (changed(before.speech_model, now.speech)) {
    // Only the ones whose words came from whisper. A video that had
    // subtitles beside it would transcribe to exactly the same text.
    const videos = await db.query(`
      INSERT INTO index_queue (kind, entity_id, event, path, run_after)
      SELECT 'video', id, 'updated', path, now() FROM index_videos WHERE speech_source = 'speech'
      ON CONFLICT (kind, entity_id) DO NOTHING
    `)
    outcome.requeued += videos.rowCount ?? 0
    outcome.changes.push(
      `the speech model changed from ${before.speech_model} to ${now.speech}`
    )
  }

  // A video has to be read again rather than skipped as unchanged, and
  // the source hash is what decides that.
  if (outcome.requeued > 0) {
    await db.query(
      "UPDATE index_videos SET source_hash = '' WHERE id IN (SELECT entity_id FROM index_queue WHERE kind = 'video')"
    )
    await db.query(
      "UPDATE index_documents SET source_hash = '' WHERE id IN (SELECT entity_id FROM index_queue WHERE kind = 'document')"
    )
  }

  if (before.vision_model !== now.vision || before.speech_model !== now.speech) {
    await db.query(
      'UPDATE index_meta SET vision_model = $1, speech_model = $2, updated_at = now() WHERE id',
      [now.vision, now.speech]
    )
  }

  if (outcome.changes.length > 0) {
    log.warn({
      changes: outcome.changes,
      requeued: outcome.requeued,
      descriptionsDropped: outcome.descriptionsDropped
    }, 'a model changed; re-reading what it produced')
  }

  return outcome
}
