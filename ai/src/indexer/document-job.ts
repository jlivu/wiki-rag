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

import { chunkDocument } from '../documents/chunk.js'
import { extractDocument } from '../documents/extract.js'
import { classify } from '../documents/kind.js'
import { ExtractionError } from '../documents/types.js'
import type { QueuedJob } from '../index-db/queue.js'
import {
  existingDocumentEmbeddings, readDocument, removeDocument, replaceDocument,
  type DocumentStatus, type IndexedDocument
} from '../index-db/store.js'
import type { WikiAsset, WikiAdminClient } from '../wiki/admin-client.js'

import { toVectorLiteral, type Embedder } from './embeddings.js'
import type { JobOutcome } from './job.js'

export interface DocumentJobOptions {
  maxBytes: number
  pageExtensions: readonly string[]
  /** Resolves an asset id to what Wiki.js currently holds. */
  findAsset: (id: number) => Promise<WikiAsset | null>
}

export async function runDocumentJob (
  db: Pool,
  wiki: WikiAdminClient,
  embedder: Embedder,
  job: QueuedJob,
  options: DocumentJobOptions
): Promise<JobOutcome> {
  if (job.event === 'deleted') {
    await removeDocument(db, job.entityId)
    return { action: 'removed', reason: 'deleted' }
  }

  const asset = await options.findAsset(job.entityId)
  if (!asset) {
    await removeDocument(db, job.entityId)
    return { action: 'removed', reason: 'gone' }
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
  const bytes = await wiki.downloadAsset(asset.path)
  const sourceHash = createHash('sha256').update(bytes).digest('hex')

  if (
    indexed &&
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

  let sections
  try {
    const extraction = await extractDocument(bytes, kind.docType)
    if (extraction.needsOcr) {
      const reason = 'no text, needs OCR'
      await record(
        db,
        { ...base, docType: kind.docType, sourceHash, status: 'needs_ocr', reason },
        embedder.model
      )
      return { action: 'skipped', reason }
    }
    sections = extraction.sections
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

  // A chunk whose text is unchanged keeps the vector it already has.
  const reusable = await existingDocumentEmbeddings(db, asset.id)
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

  await replaceDocument(
    db,
    { ...base, docType: kind.docType, sourceHash, status: 'indexed', reason: '' },
    rows,
    embedder.model
  )

  return { action: 'indexed', chunks: rows.length, embedded: fresh.length }
}

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
