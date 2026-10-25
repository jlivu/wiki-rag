/**
 * Hybrid retrieval over the chunk index.
 *
 * Two searches run over the same chunks — nearest neighbours by cosine
 * distance (HNSW) and full text (GIN) — and their rankings are merged with
 * reciprocal rank fusion. RRF needs no score calibration between the two,
 * which matters because a cosine distance and a ts_rank_cd are not
 * comparable numbers.
 *
 * Pages and uploaded documents share the tables, so one query ranks both
 * against each other. A document has no locale, so a search narrowed to one
 * locale still sees every file.
 */
import type { Pool } from 'pg'

/** score = Σ 1 / (RRF_K + rank). 60 is the value from the original paper. */
const RRF_K = 60

export interface ChunkHit {
  chunkId: number
  kind: 'page' | 'document'
  /** The page id or the document id, by kind. */
  ownerId: number
  ordinal: number
  headingPath: string
  /** Wiki.js's anchor for a section, or "#page=4" for a PDF page. */
  anchor: string
  /** Where in a document: "Page 4", "Sheet \"Budget\" rows 12–40". */
  location: string
  /** For an image: 'ocr', 'alt' or 'description'. Empty otherwise. */
  origin: string
  text: string
  score: number
  vectorRank: number | null
  textRank: number | null
  /** The page title, or the document's file name. */
  title: string
  path: string
  /** Empty for a document: files are not localised. */
  locale: string
  updatedAt: string
  /** Documents only. */
  fileName: string
  docType: string
  mime: string
  fileSize: number
}

/**
 * The owner columns, resolved once. Everything below joins `owner` instead
 * of index_pages, so the two kinds rank in one list.
 */
const OWNER_SQL = `
  owner AS (
    SELECT
      c.id AS chunk_id,
      CASE WHEN c.page_id IS NULL THEN 'document' ELSE 'page' END AS kind,
      coalesce(p.id, d.id)                     AS owner_id,
      coalesce(p.title, d.file_name, '')       AS title,
      coalesce(p.path, d.path, '')             AS path,
      coalesce(p.locale, '')                   AS locale,
      coalesce(p.updated_at, d.updated_at)     AS updated_at,
      coalesce(d.file_name, '')                AS file_name,
      coalesce(d.doc_type, '')                 AS doc_type,
      coalesce(d.mime, '')                     AS mime,
      coalesce(d.file_size, 0)                 AS file_size
    FROM index_chunks c
    LEFT JOIN index_pages p     ON p.id = c.page_id
    LEFT JOIN index_documents d ON d.id = c.document_id
    -- A page inside its publish window only. The window closes without an
    -- event, so the index can be a day stale; filtering here makes it take
    -- effect the moment it closes, whatever the indexer has caught up with.
    WHERE c.page_id IS NULL
       OR ((p.publish_start IS NULL OR p.publish_start <= now())
       AND (p.publish_end   IS NULL OR p.publish_end   >= now()))
  )
`

const HYBRID_SQL = `
  WITH ${OWNER_SQL},
  vec AS (
    SELECT chunk_id, row_number() OVER (ORDER BY distance) AS rank
    FROM (
      SELECT c.id AS chunk_id, c.embedding <=> $1::vector AS distance
      FROM index_chunks c
      JOIN owner o ON o.chunk_id = c.id
      WHERE c.embedding IS NOT NULL
        AND ($2::text IS NULL OR o.kind = 'document' OR o.locale = $2::text)
      ORDER BY c.embedding <=> $1::vector
      LIMIT $4
    ) nearest
  ),
  tsq AS (
    SELECT websearch_to_tsquery('english', $3::text) AS query
  ),
  fts AS (
    SELECT chunk_id, row_number() OVER (ORDER BY rank_cd DESC) AS rank
    FROM (
      SELECT c.id AS chunk_id, ts_rank_cd(c.fts, tsq.query) AS rank_cd
      FROM index_chunks c
      JOIN owner o ON o.chunk_id = c.id
      CROSS JOIN tsq
      WHERE c.fts @@ tsq.query
        AND ($2::text IS NULL OR o.kind = 'document' OR o.locale = $2::text)
      ORDER BY ts_rank_cd(c.fts, tsq.query) DESC
      LIMIT $4
    ) matched
  ),
  fused AS (
    SELECT
      chunk_id,
      sum(1.0 / ($5::numeric + rank)) AS score,
      max(CASE WHEN source = 'vec' THEN rank END) AS vector_rank,
      max(CASE WHEN source = 'fts' THEN rank END) AS text_rank
    FROM (
      SELECT chunk_id, rank, 'vec' AS source FROM vec
      UNION ALL
      SELECT chunk_id, rank, 'fts' AS source FROM fts
    ) ranked
    GROUP BY chunk_id
  )
  SELECT
    c.id, c.ordinal, c.heading_path, c.anchor, c.location, c.origin, c.text,
    f.score::float8 AS score, f.vector_rank, f.text_rank,
    o.kind, o.owner_id, o.title, o.path, o.locale, o.updated_at,
    o.file_name, o.doc_type, o.mime, o.file_size
  FROM fused f
  JOIN index_chunks c ON c.id = f.chunk_id
  JOIN owner o ON o.chunk_id = c.id
  ORDER BY f.score DESC, o.kind, o.owner_id, c.ordinal
`

export async function searchChunks (
  db: Pool,
  queryEmbedding: string,
  query: string,
  locale: string | null,
  perList: number
): Promise<ChunkHit[]> {
  const { rows } = await db.query<{
    id: number, kind: 'page' | 'document', owner_id: number, ordinal: number,
    heading_path: string, anchor: string, location: string, origin: string, text: string,
    score: number, vector_rank: number | null, text_rank: number | null,
    title: string, path: string, locale: string, updated_at: Date,
    file_name: string, doc_type: string, mime: string, file_size: string
  }>(HYBRID_SQL, [queryEmbedding, locale, query, perList, RRF_K])

  return rows.map(row => ({
    chunkId: row.id,
    kind: row.kind,
    ownerId: row.owner_id,
    ordinal: row.ordinal,
    headingPath: row.heading_path,
    anchor: row.anchor,
    location: row.location,
    origin: row.origin,
    text: row.text,
    score: row.score,
    vectorRank: row.vector_rank,
    textRank: row.text_rank,
    title: row.title,
    path: row.path,
    locale: row.locale,
    updatedAt: row.updated_at.toISOString(),
    fileName: row.file_name,
    docType: row.doc_type,
    mime: row.mime,
    fileSize: Number(row.file_size)
  }))
}

/** Every chunk of one document, in order: what get_document reads. */
export async function documentChunks (
  db: Pool,
  documentId: number
): Promise<Array<{ ordinal: number, location: string, anchor: string, origin: string, text: string }>> {
  const { rows } = await db.query<{
    ordinal: number, location: string, anchor: string, origin: string, text: string
  }>(
    'SELECT ordinal, location, anchor, origin, text FROM index_chunks WHERE document_id = $1 ORDER BY ordinal',
    [documentId]
  )
  return rows
}

/** A document by its path, for get_document and for citations. */
export async function findDocumentByPath (
  db: Pool,
  path: string
): Promise<{
  id: number, path: string, fileName: string, docType: string, mime: string,
  fileSize: number, updatedAt: string, status: string, reason: string
} | null> {
  const { rows } = await db.query<{
    id: number, path: string, file_name: string, doc_type: string, mime: string,
    file_size: string, updated_at: Date, status: string, reason: string
  }>(`
    SELECT id, path, file_name, doc_type, mime, file_size, updated_at, status, reason
    FROM index_documents WHERE path = $1
  `, [path])
  const row = rows[0]
  return row
    ? {
        id: row.id,
        path: row.path,
        fileName: row.file_name,
        docType: row.doc_type,
        mime: row.mime,
        fileSize: Number(row.file_size),
        updatedAt: row.updated_at.toISOString(),
        status: row.status,
        reason: row.reason
      }
    : null
}

export async function chunkCount (db: Pool): Promise<number> {
  const { rows } = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM index_chunks')
  return Number(rows[0]?.count ?? 0)
}
