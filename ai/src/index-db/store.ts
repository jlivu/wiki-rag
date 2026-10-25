/**
 * Reading and writing what the index holds: pages, uploaded documents, and
 * the chunks of either.
 */
import type { Pool, PoolClient } from 'pg'

import { withTransaction } from './pool.js'

export interface IndexedPage {
  id: number
  path: string
  locale: string
  title: string
  description: string
  contentType: string
  sourceHash: string
  updatedAt: string
}

export interface ChunkInput {
  ordinal: number
  headingPath: string
  anchor: string
  /** Where in a document this came from: "Page 4", "Slide 7". Pages use ''. */
  location?: string
  text: string
  contentHash: string
  tokens: number
  /** Null when it is reused from an existing row with the same hash. */
  embedding: number[] | null
}

/** One uploaded file, as the index holds it. */
export interface IndexedDocument {
  id: number
  /** Folder slugs and the file name, as Wiki.js serves it: no locale. */
  path: string
  fileName: string
  ext: string
  mime: string
  /** pdf, docx, xlsx, pptx, csv — what decided the extractor. */
  docType: string
  fileSize: number
  updatedAt: string
  sourceHash: string
  /** indexed, needs_ocr, skipped or failed. */
  status: DocumentStatus
  reason: string
}

export type DocumentStatus = 'indexed' | 'needs_ocr' | 'skipped' | 'failed'

export async function listIndexedPages (db: Pool): Promise<Array<{ id: number, updatedAt: string }>> {
  const { rows } = await db.query<{ id: number, updated_at: Date }>(
    'SELECT id, updated_at FROM index_pages'
  )
  return rows.map(row => ({ id: row.id, updatedAt: row.updated_at.toISOString() }))
}

/** Embeddings already held for this page, by chunk hash. */
export async function existingEmbeddings (db: Pool, pageId: number): Promise<Map<string, string>> {
  return embeddingsWhere(db, 'page_id = $1', pageId)
}

/** The same, for a document. */
export async function existingDocumentEmbeddings (db: Pool, documentId: number): Promise<Map<string, string>> {
  return embeddingsWhere(db, 'document_id = $1', documentId)
}

async function embeddingsWhere (db: Pool, where: string, id: number): Promise<Map<string, string>> {
  const { rows } = await db.query<{ content_hash: string, embedding: string | null }>(
    `SELECT content_hash, embedding::text AS embedding FROM index_chunks WHERE ${where}`,
    [id]
  )
  const byHash = new Map<string, string>()
  for (const row of rows) {
    if (row.embedding) { byHash.set(row.content_hash, row.embedding) }
  }
  return byHash
}

/**
 * Replace everything the index holds for one page, in one transaction, so a
 * reader never sees a half-rewritten page.
 */
export async function replacePage (
  db: Pool,
  page: IndexedPage,
  chunks: Array<ChunkInput & { embeddingLiteral: string }>,
  embedModel: string
): Promise<void> {
  await withTransaction(db, async client => {
    await client.query(`
      INSERT INTO index_pages (id, path, locale, title, description, content_type, source_hash, updated_at, indexed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
      ON CONFLICT (id) DO UPDATE SET
        path = EXCLUDED.path, locale = EXCLUDED.locale, title = EXCLUDED.title,
        description = EXCLUDED.description, content_type = EXCLUDED.content_type,
        source_hash = EXCLUDED.source_hash, updated_at = EXCLUDED.updated_at, indexed_at = now()
    `, [page.id, page.path, page.locale, page.title, page.description, page.contentType, page.sourceHash, page.updatedAt])

    // A page can be renamed onto a path an older, since-deleted row still
    // holds; the unique index would reject the upsert above otherwise.
    await client.query(
      'DELETE FROM index_pages WHERE locale = $1 AND path = $2 AND id <> $3',
      [page.locale, page.path, page.id]
    )

    await client.query('DELETE FROM index_chunks WHERE page_id = $1', [page.id])
    await insertChunks(client, { pageId: page.id }, chunks, embedModel)
  })
}

/** Chunks belong to a page or to a document; the rows are otherwise alike. */
async function insertChunks (
  client: PoolClient,
  owner: { pageId: number } | { documentId: number },
  chunks: Array<ChunkInput & { embeddingLiteral: string }>,
  embedModel: string
): Promise<void> {
  const pageId = 'pageId' in owner ? owner.pageId : null
  const documentId = 'documentId' in owner ? owner.documentId : null
  for (const chunk of chunks) {
    await client.query(`
      INSERT INTO index_chunks
        (page_id, document_id, ordinal, heading_path, anchor, location, text, content_hash, embed_model, tokens, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
    `, [
      pageId, documentId, chunk.ordinal, chunk.headingPath, chunk.anchor, chunk.location ?? '',
      chunk.text, chunk.contentHash, embedModel, chunk.tokens, chunk.embeddingLiteral
    ])
  }
}

/** What the index already holds for a page, if anything. */
export async function readPage (db: Pool, pageId: number): Promise<IndexedPage | null> {
  const { rows } = await db.query<{
    id: number, path: string, locale: string, title: string, description: string,
    content_type: string, source_hash: string, updated_at: Date
  }>('SELECT * FROM index_pages WHERE id = $1', [pageId])
  const row = rows[0]
  return row
    ? {
        id: row.id,
        path: row.path,
        locale: row.locale,
        title: row.title,
        description: row.description,
        contentType: row.content_type,
        sourceHash: row.source_hash,
        updatedAt: row.updated_at.toISOString()
      }
    : null
}

export async function touchPage (db: Pool, pageId: number, updatedAt: string): Promise<void> {
  await db.query(
    'UPDATE index_pages SET updated_at = $2, indexed_at = now() WHERE id = $1',
    [pageId, updatedAt]
  )
}

export async function removePage (db: Pool, pageId: number): Promise<void> {
  // Chunks go with it: the foreign key cascades.
  await db.query('DELETE FROM index_pages WHERE id = $1', [pageId])
}

export async function renamePage (
  db: Pool,
  pageId: number,
  path: string,
  locale: string
): Promise<void> {
  await db.query(
    'UPDATE index_pages SET path = $2, locale = $3, indexed_at = now() WHERE id = $1',
    [pageId, path, locale]
  )
}

export interface IndexStats {
  pages: number
  documents: number
  /** Files listed but not indexed: an image, too large, or unreadable. */
  skippedDocuments: number
  chunks: number
  embedModel: string | null
  embedDims: number | null
  lastIndexedAt: string | null
}

export async function readStats (db: Pool): Promise<IndexStats> {
  const { rows } = await db.query<{
    pages: string, documents: string, skipped: string, chunks: string,
    embed_model: string | null, embed_dims: number | null, last_indexed: Date | null
  }>(`
    SELECT
      (SELECT count(*)::text FROM index_pages) AS pages,
      (SELECT count(*)::text FROM index_documents WHERE status = 'indexed') AS documents,
      (SELECT count(*)::text FROM index_documents WHERE status <> 'indexed') AS skipped,
      (SELECT count(*)::text FROM index_chunks) AS chunks,
      (SELECT embed_model FROM index_meta WHERE id) AS embed_model,
      (SELECT embed_dims FROM index_meta WHERE id) AS embed_dims,
      (SELECT max(indexed_at) FROM index_pages) AS last_indexed
  `)
  const row = rows[0]
  return {
    pages: Number(row?.pages ?? 0),
    documents: Number(row?.documents ?? 0),
    skippedDocuments: Number(row?.skipped ?? 0),
    chunks: Number(row?.chunks ?? 0),
    embedModel: row?.embed_model ?? null,
    embedDims: row?.embed_dims ?? null,
    lastIndexedAt: row?.last_indexed ? row.last_indexed.toISOString() : null
  }
}

/* ── documents ─────────────────────────────────────────────────────── */

export async function listIndexedDocuments (
  db: Pool
): Promise<Array<{ id: number, path: string, updatedAt: string, fileSize: number, sourceHash: string }>> {
  const { rows } = await db.query<{
    id: number, path: string, updated_at: Date, file_size: string, source_hash: string
  }>('SELECT id, path, updated_at, file_size, source_hash FROM index_documents')
  return rows.map(row => ({
    id: row.id,
    path: row.path,
    updatedAt: row.updated_at.toISOString(),
    fileSize: Number(row.file_size),
    sourceHash: row.source_hash
  }))
}

export async function readDocument (db: Pool, id: number): Promise<IndexedDocument | null> {
  const { rows } = await db.query<DocumentRow>('SELECT * FROM index_documents WHERE id = $1', [id])
  const row = rows[0]
  return row ? toDocument(row) : null
}

/**
 * Replace everything the index holds for one document, in one transaction.
 * A file with no chunks — an image, one too large, a scan with no text — is
 * still recorded, with the reason, so the next reconciliation knows it has
 * been looked at and an administrator can see why it is not searchable.
 */
export async function replaceDocument (
  db: Pool,
  document: IndexedDocument,
  chunks: Array<ChunkInput & { embeddingLiteral: string }>,
  embedModel: string
): Promise<void> {
  await withTransaction(db, async client => {
    await client.query(`
      INSERT INTO index_documents
        (id, path, file_name, ext, mime, doc_type, file_size, updated_at, source_hash, status, reason, indexed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
      ON CONFLICT (id) DO UPDATE SET
        path = EXCLUDED.path, file_name = EXCLUDED.file_name, ext = EXCLUDED.ext,
        mime = EXCLUDED.mime, doc_type = EXCLUDED.doc_type, file_size = EXCLUDED.file_size,
        updated_at = EXCLUDED.updated_at, source_hash = EXCLUDED.source_hash,
        status = EXCLUDED.status, reason = EXCLUDED.reason, indexed_at = now()
    `, [
      document.id, document.path, document.fileName, document.ext, document.mime, document.docType,
      document.fileSize, document.updatedAt, document.sourceHash, document.status, document.reason
    ])

    // A file can be renamed onto a path an older, since-deleted row holds.
    await client.query('DELETE FROM index_documents WHERE path = $1 AND id <> $2', [document.path, document.id])

    await client.query('DELETE FROM index_chunks WHERE document_id = $1', [document.id])
    await insertChunks(client, { documentId: document.id }, chunks, embedModel)
  })
}

export async function removeDocument (db: Pool, id: number): Promise<void> {
  // Chunks go with it: the foreign key cascades.
  await db.query('DELETE FROM index_documents WHERE id = $1', [id])
}

/* ── which pages link to a file ────────────────────────────────────── */

/** Replace the links found on one page. */
export async function replaceDocumentLinks (db: Pool, pageId: number, assetPaths: string[]): Promise<void> {
  await withTransaction(db, async client => {
    await client.query('DELETE FROM index_document_links WHERE page_id = $1', [pageId])
    for (const path of new Set(assetPaths)) {
      await client.query(
        'INSERT INTO index_document_links (asset_path, page_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [path, pageId]
      )
    }
  })
}

export interface LinkingPage {
  id: number
  title: string
  path: string
  locale: string
}

/** The pages that link to a file, for the "Linked from" line on a source. */
export async function linkingPages (db: Pool, assetPath: string, limit = 5): Promise<LinkingPage[]> {
  const { rows } = await db.query<{ id: number, title: string, path: string, locale: string }>(`
    SELECT p.id, p.title, p.path, p.locale
    FROM index_document_links l
    JOIN index_pages p ON p.id = l.page_id
    WHERE l.asset_path = $1
    ORDER BY p.title
    LIMIT $2
  `, [assetPath, limit])
  return rows
}

interface DocumentRow {
  id: number
  path: string
  file_name: string
  ext: string
  mime: string
  doc_type: string
  file_size: string
  updated_at: Date
  source_hash: string
  status: DocumentStatus
  reason: string
}

function toDocument (row: DocumentRow): IndexedDocument {
  return {
    id: row.id,
    path: row.path,
    fileName: row.file_name,
    ext: row.ext,
    mime: row.mime,
    docType: row.doc_type,
    fileSize: Number(row.file_size),
    updatedAt: row.updated_at.toISOString(),
    sourceHash: row.source_hash,
    status: row.status,
    reason: row.reason
  }
}
