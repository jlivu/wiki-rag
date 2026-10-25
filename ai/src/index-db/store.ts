/**
 * Reading and writing indexed pages and their chunks.
 */
import type { Pool } from 'pg'

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
  text: string
  contentHash: string
  tokens: number
  /** Null when it is reused from an existing row with the same hash. */
  embedding: number[] | null
}

export async function listIndexedPages (db: Pool): Promise<Array<{ id: number, updatedAt: string }>> {
  const { rows } = await db.query<{ id: number, updated_at: Date }>(
    'SELECT id, updated_at FROM index_pages'
  )
  return rows.map(row => ({ id: row.id, updatedAt: row.updated_at.toISOString() }))
}

/** Embeddings already held for this page, by chunk hash. */
export async function existingEmbeddings (db: Pool, pageId: number): Promise<Map<string, string>> {
  const { rows } = await db.query<{ content_hash: string, embedding: string | null }>(
    'SELECT content_hash, embedding::text AS embedding FROM index_chunks WHERE page_id = $1',
    [pageId]
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

    for (const chunk of chunks) {
      await client.query(`
        INSERT INTO index_chunks (page_id, ordinal, heading_path, anchor, text, content_hash, embed_model, tokens, embedding)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
      `, [page.id, chunk.ordinal, chunk.headingPath, chunk.anchor, chunk.text, chunk.contentHash, embedModel, chunk.tokens, chunk.embeddingLiteral])
    }
  })
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
  chunks: number
  embedModel: string | null
  embedDims: number | null
  lastIndexedAt: string | null
}

export async function readStats (db: Pool): Promise<IndexStats> {
  const { rows } = await db.query<{
    pages: string, chunks: string, embed_model: string | null, embed_dims: number | null, last_indexed: Date | null
  }>(`
    SELECT
      (SELECT count(*)::text FROM index_pages) AS pages,
      (SELECT count(*)::text FROM index_chunks) AS chunks,
      (SELECT embed_model FROM index_meta WHERE id) AS embed_model,
      (SELECT embed_dims FROM index_meta WHERE id) AS embed_dims,
      (SELECT max(indexed_at) FROM index_pages) AS last_indexed
  `)
  const row = rows[0]
  return {
    pages: Number(row?.pages ?? 0),
    chunks: Number(row?.chunks ?? 0),
    embedModel: row?.embed_model ?? null,
    embedDims: row?.embed_dims ?? null,
    lastIndexedAt: row?.last_indexed ? row.last_indexed.toISOString() : null
  }
}
