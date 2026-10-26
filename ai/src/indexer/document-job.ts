/**
 * Indexing one uploaded file.
 *
 * A file that cannot be indexed is still recorded, with the reason, so the
 * next reconciliation knows it has been looked at and an administrator can
 * see why it is not searchable. Only a transient failure — the wiki being
 * unreachable, the embedding model being down — is left to the queue to
 * retry; a file we will never be able to read is not retried five times.
 */
import { createHash } from 'node:crypto'

import type { Pool } from 'pg'

import { chunkDocument, type DocChunk } from '../documents/chunk.js'
import { extractDocument } from '../documents/extract.js'
import { classify } from '../documents/kind.js'
import type { DocSection } from '../documents/types.js'
import { ExtractionError } from '../documents/types.js'
import type { ImageDescriber } from '../images/describe.js'
import { ocrPdf } from '../images/ocr.js'
import type { QueuedJob } from '../index-db/queue.js'
import {
  existingDocumentEmbeddings, readDocument, removeDocument, replaceDocument,
  type DocumentStatus, type IndexedDocument
} from '../index-db/store.js'
import type { WikiAsset, WikiAdminClient } from '../wiki/admin-client.js'
import { WikiError } from '../wiki/client.js'

import { toVectorLiteral, type Embedder } from './embeddings.js'
import { ORIGIN_LABELS, readImage } from './image-job.js'
import type { JobOutcome } from './job.js'

export interface DocumentJobOptions {
  maxBytes: number
  pageExtensions: readonly string[]
  /** Resolves an asset id to what Wiki.js currently holds. */
  findAsset: (id: number) => Promise<WikiAsset | null>
  images: {
    excludeFolders: readonly string[]
    dailyLimit: number
    describer: ImageDescriber
  }
}

export async function runDocumentJob (
  db: Pool,
  wiki: WikiAdminClient,
  embedder: Embedder,
  job: QueuedJob,
  options: DocumentJobOptions
): Promise<JobOutcome> {
  if (job.event === 'deleted') {
    const descriptions = await removeDocument(db, job.entityId)
    return { action: 'removed', reason: 'deleted', ...(descriptions > 0 ? { descriptions } : {}) }
  }

  const asset = await options.findAsset(job.entityId)
  if (!asset) {
    const descriptions = await removeDocument(db, job.entityId)
    return { action: 'removed', reason: 'gone', ...(descriptions > 0 ? { descriptions } : {}) }
  }

  const base: Omit<IndexedDocument, 'docType' | 'sourceHash' | 'status' | 'reason'> = {
    id: asset.id,
    path: asset.path,
    fileName: asset.fileName,
    ext: asset.ext,
    mime: asset.mime,
    fileSize: asset.fileSize,
    updatedAt: asset.updatedAt
  }

  // Images, oversized files and formats we cannot read are decided before
  // anything is downloaded.
  const kind = classify({
    path: asset.path,
    fileName: asset.fileName,
    ext: asset.ext,
    mime: asset.mime,
    assetKind: asset.kind,
    fileSize: asset.fileSize,
    maxBytes: options.maxBytes,
    pageExtensions: options.pageExtensions
  })
  if (!kind.index) {
    await record(db, { ...base, docType: '', sourceHash: '', status: 'skipped', reason: kind.reason }, embedder.model)
    return { action: 'skipped', reason: kind.reason }
  }

  const indexed = await readDocument(db, asset.id)

  // The listing is cached for a few seconds, so a file deleted a moment
  // ago can still be in it. The download is the moment we find out. It is
  // recorded rather than removed, because the same 404 means "not there"
  // and "Wiki.js will not serve this path", and a removed row would be
  // queued again by the next reconciliation either way.
  let bytes: Buffer
  try {
    bytes = await wiki.downloadAsset(asset.path)
  } catch (err) {
    if (err instanceof WikiError && err.status === 404) {
      const reason = 'the wiki no longer serves this file'
      await record(db, { ...base, docType: '', sourceHash: '', status: 'skipped', reason }, embedder.model)
      return { action: 'skipped', reason }
    }
    throw err
  }
  const sourceHash = createHash('sha256').update(bytes).digest('hex')

  // An image is read again every time it is queued, because some of its
  // text comes from outside the file: a page that gains a caption makes
  // the image stale without changing a byte of it. Re-reading is cheap —
  // OCR is local, and the description is looked up by content hash — and
  // nothing queues an image unless something about it changed.
  if (
    indexed &&
    kind.docType !== 'image' &&
    indexed.status === 'indexed' &&
    indexed.sourceHash === sourceHash &&
    indexed.path === asset.path &&
    indexed.fileName === asset.fileName
  ) {
    await record(
      db,
      { ...base, docType: kind.docType, sourceHash, status: 'indexed', reason: '' },
      embedder.model,
      { keepChunks: true }
    )
    return { action: 'skipped', reason: 'unchanged' }
  }

  let sections: DocSection[]
  let extra: Record<string, unknown> = {}

  try {
    if (kind.docType === 'image') {
      // A picture's text comes from three places; readImage returns the
      // chunks already cut, because each source is its own chunk.
      const read = await readImage(db, bytes, {
        path: asset.path, fileName: asset.fileName, ext: asset.ext
      }, sourceHash, options.images)

      if (read.chunks.length === 0) {
        // A picture whose only content was a generated description, read
        // again on a day the describer answered with nothing or the daily
        // allowance had run out, would otherwise be recorded as having
        // nothing in it — and nothing would ever queue it again, so one
        // bad minute would quietly take it out of the index for good.
        // What is already there is kept and the next pass tries again.
        const transient = read.described === 'empty' || read.described === 'over-limit'
        if (transient && indexed?.status === 'indexed') {
          const reason = read.described === 'over-limit'
            ? 'the day\'s description allowance is used up; keeping what is indexed'
            : 'the description came back empty; keeping what is indexed'
          await record(
            db,
            { ...base, docType: 'image', sourceHash: indexed.sourceHash, status: 'indexed', reason: '' },
            embedder.model,
            { keepChunks: true }
          )
          return { action: 'skipped', reason, described: read.described }
        }
        const reason = 'no text, no alt text and no description'
        await record(db, { ...base, docType: 'image', sourceHash, status: 'needs_ocr', reason }, embedder.model)
        return { action: 'skipped', reason }
      }
      return await store(db, embedder, { ...base, docType: 'image', sourceHash }, read.chunks, {
        ocrChars: read.ocrChars,
        altSources: read.altSources,
        described: read.described,
        ...(read.describeModel ? { describeModel: read.describeModel } : {}),
        ...(read.describeInputTokens !== undefined ? { describeInputTokens: read.describeInputTokens } : {}),
        ...(read.describeOutputTokens !== undefined ? { describeOutputTokens: read.describeOutputTokens } : {}),
        ...(read.describeMs !== undefined ? { describeMs: read.describeMs } : {}),
        ...(read.sentPixels ? { sentPixels: read.sentPixels } : {}),
        ...(read.sentTokens !== undefined ? { sentTokens: read.sentTokens } : {})
      })
    }

    const extraction = await extractDocument(bytes, kind.docType)
    if (extraction.needsOcr) {
      // A scan: no text layer, so every page is rendered and read. The
      // page numbers survive, so a citation still says "Page 4".
      const scanned = await ocrPdf(bytes)
      if (scanned.pages.length === 0) {
        const reason = 'no text, needs OCR'
        await record(
          db,
          { ...base, docType: kind.docType, sourceHash, status: 'needs_ocr', reason },
          embedder.model
        )
        return { action: 'skipped', reason }
      }
      sections = scanned.pages.map(page => ({
        label: `Page ${page.page}`,
        origin: 'ocr',
        anchor: `#page=${page.page}`,
        text: page.text
      }))
      extra = {
        ocr: true,
        ocrPages: scanned.pages.length,
        totalPages: scanned.totalPages,
        ocrMs: scanned.ms,
        ...(scanned.truncated ? { ocrTruncated: true } : {})
      }
    } else {
      sections = extraction.sections
    }
  } catch (err) {
    // A file we will never be able to read: record it rather than retry.
    if (err instanceof ExtractionError) {
      await record(
        db,
        { ...base, docType: kind.docType, sourceHash, status: 'failed', reason: err.message },
        embedder.model
      )
      return { action: 'skipped', reason: err.message }
    }
    throw err
  }

  const chunks = chunkDocument(asset.fileName, sections)
  if (chunks.length === 0) {
    const reason = 'no text could be extracted'
    await record(db, { ...base, docType: kind.docType, sourceHash, status: 'failed', reason }, embedder.model)
    return { action: 'skipped', reason }
  }

  return await store(db, embedder, { ...base, docType: kind.docType, sourceHash }, chunks, extra)
}

/** Embed whatever is new and replace the document's chunks. */
async function store (
  db: Pool,
  embedder: Embedder,
  document: Omit<IndexedDocument, 'status' | 'reason'>,
  chunks: DocChunk[],
  extra: Record<string, unknown>
): Promise<JobOutcome> {
  // A chunk whose text is unchanged keeps the vector it already has.
  const reusable = await existingDocumentEmbeddings(db, document.id)
  const fresh = chunks.filter(chunk => !reusable.has(chunk.contentHash))
  const vectors = await embedder.embed(fresh.map(chunk => chunk.text))

  const byHash = new Map(reusable)
  fresh.forEach((chunk, at) => {
    const vector = vectors[at]
    if (vector) { byHash.set(chunk.contentHash, toVectorLiteral(vector)) }
  })

  const rows = chunks.flatMap(chunk => {
    const embeddingLiteral = byHash.get(chunk.contentHash)
    return embeddingLiteral ? [{ ...chunk, embedding: null, embeddingLiteral }] : []
  })

  await replaceDocument(db, { ...document, status: 'indexed', reason: '' }, rows, embedder.model)
  return { action: 'indexed', chunks: rows.length, embedded: fresh.length, ...extra }
}

export { ORIGIN_LABELS }

/**
 * Write the document row with no chunks — or, when the file is unchanged
 * and only its metadata moved, leaving the chunks where they are.
 */
async function record (
  db: Pool,
  document: IndexedDocument & { status: DocumentStatus },
  embedModel: string,
  options: { keepChunks?: boolean } = {}
): Promise<void> {
  if (options.keepChunks) {
    await db.query(`
      UPDATE index_documents
      SET path = $2, file_name = $3, ext = $4, mime = $5, doc_type = $6, file_size = $7,
          updated_at = $8, status = $9, reason = $10, indexed_at = now()
      WHERE id = $1
    `, [
      document.id, document.path, document.fileName, document.ext, document.mime,
      document.docType, document.fileSize, document.updatedAt, document.status, document.reason
    ])
    return
  }
  await replaceDocument(db, document, [], embedModel)
}
