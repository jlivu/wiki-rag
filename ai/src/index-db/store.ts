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
  /** For an image: 'ocr', 'alt' or 'description'. Empty for text. */
  origin?: string
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
        (page_id, document_id, ordinal, heading_path, anchor, location, origin,
         text, content_hash, embed_model, tokens, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)
    `, [
      pageId, documentId, chunk.ordinal, chunk.headingPath, chunk.anchor, chunk.location ?? '',
      chunk.origin ?? '', chunk.text, chunk.contentHash, embedModel, chunk.tokens, chunk.embeddingLiteral
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

/* ── what a page says about an image ───────────────────────────────── */

export interface PageImageText {
  assetPath: string
  alt: string
  caption: string
}

/** Replace the alt text and captions one page gives the images it shows. */
export async function replaceImageText (
  db: Pool,
  pageId: number,
  images: PageImageText[]
): Promise<void> {
  await withTransaction(db, async client => {
    await client.query('DELETE FROM index_image_text WHERE page_id = $1', [pageId])
    // A page can show the same image twice; the two entries are merged
    // rather than fighting over the primary key.
    const merged = new Map<string, PageImageText>()
    for (const image of images) {
      const existing = merged.get(image.assetPath)
      if (!existing) {
        merged.set(image.assetPath, { ...image })
        continue
      }
      if (existing.alt.length === 0) { existing.alt = image.alt }
      if (image.caption.length > 0 && !existing.caption.includes(image.caption)) {
        existing.caption = [existing.caption, image.caption].filter(Boolean).join(' ')
      }
    }
    for (const image of merged.values()) {
      if (image.alt.length === 0 && image.caption.length === 0) { continue }
      await client.query(
        'INSERT INTO index_image_text (asset_path, page_id, alt, caption) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [image.assetPath, pageId, image.alt, image.caption]
      )
    }
  })
}

/** Everything the wiki's pages call one image. */
export async function imageTextFor (
  db: Pool,
  assetPath: string
): Promise<Array<{ pageId: number, title: string, alt: string, caption: string }>> {
  const { rows } = await db.query<{ page_id: number, title: string, alt: string, caption: string }>(`
    SELECT t.page_id, p.title, t.alt, t.caption
    FROM index_image_text t
    JOIN index_pages p ON p.id = t.page_id
    WHERE t.asset_path = $1
    ORDER BY p.title
  `, [assetPath])
  return rows.map(row => ({ pageId: row.page_id, title: row.title, alt: row.alt, caption: row.caption }))
}

/** The asset paths a page mentions, to notice when its alt text changed. */
export async function imagePathsOnPage (db: Pool, pageId: number): Promise<string[]> {
  const { rows } = await db.query<{ asset_path: string }>(
    'SELECT asset_path FROM index_image_text WHERE page_id = $1', [pageId]
  )
  return rows.map(row => row.asset_path)
}

/** The indexed images at these paths, so a changed caption can re-index them. */
export async function documentIdsByPath (db: Pool, paths: string[]): Promise<number[]> {
  if (paths.length === 0) { return [] }
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM index_documents WHERE path = ANY($1::text[])', [paths]
  )
  return rows.map(row => row.id)
}

/* ── generated descriptions ────────────────────────────────────────── */

export interface StoredDescription {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
}

/** A description is kept against the image's bytes, not its path, so the
 *  same picture is never described twice however often it is uploaded. */
export async function readDescription (db: Pool, contentHash: string): Promise<StoredDescription | null> {
  const { rows } = await db.query<{
    text: string, model: string, input_tokens: number, output_tokens: number
  }>(
    'SELECT text, model, input_tokens, output_tokens FROM index_image_descriptions WHERE content_hash = $1',
    [contentHash]
  )
  const row = rows[0]
  return row
    ? { text: row.text, model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens }
    : null
}

export async function saveDescription (
  db: Pool,
  contentHash: string,
  description: StoredDescription
): Promise<void> {
  await db.query(`
    INSERT INTO index_image_descriptions (content_hash, model, text, input_tokens, output_tokens)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (content_hash) DO UPDATE SET
      model = EXCLUDED.model, text = EXCLUDED.text,
      input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens
  `, [contentHash, description.model, description.text, description.inputTokens, description.outputTokens])
}

/** How many images have been described since midnight, for the daily cap. */
export async function describedToday (db: Pool): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM index_image_descriptions WHERE created_at >= date_trunc('day', now())"
  )
  return Number(rows[0]?.count ?? 0)
}

/** Tokens spent on descriptions today, for the log line. */
export async function describeSpendToday (db: Pool): Promise<{ images: number, inputTokens: number, outputTokens: number }> {
  const { rows } = await db.query<{ images: string, input: string, output: string }>(`
    SELECT count(*)::text AS images,
           coalesce(sum(input_tokens), 0)::text AS input,
           coalesce(sum(output_tokens), 0)::text AS output
    FROM index_image_descriptions
    WHERE created_at >= date_trunc('day', now())
  `)
  const row = rows[0]
  return {
    images: Number(row?.images ?? 0),
    inputTokens: Number(row?.input ?? 0),
    outputTokens: Number(row?.output ?? 0)
  }
}
