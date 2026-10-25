/**
 * Hybrid retrieval over the chunk index.
 *
 * Two searches run over the same chunks — nearest neighbours by cosine
 * distance (HNSW) and full text (GIN) — and their rankings are merged with
 * reciprocal rank fusion. RRF needs no score calibration between the two,
 * which matters because a cosine distance and a ts_rank_cd are not
 * comparable numbers.
 */
import type { Pool } from 'pg'

/** score = Σ 1 / (RRF_K + rank). 60 is the value from the original paper. */
const RRF_K = 60

export interface ChunkHit {
  chunkId: number
  pageId: number
  ordinal: number
  headingPath: string
  /** Wiki.js's anchor for the section, e.g. "#troubleshooting". */
  anchor: string
  text: string
  score: number
  vectorRank: number | null
  textRank: number | null
  title: string
  path: string
  locale: string
  updatedAt: string
}

const HYBRID_SQL = `
  WITH vec AS (
    SELECT chunk_id, row_number() OVER (ORDER BY distance) AS rank
    FROM (
      SELECT c.id AS chunk_id, c.embedding <=> $1::vector AS distance
      FROM index_chunks c
      JOIN index_pages p ON p.id = c.page_id
      WHERE c.embedding IS NOT NULL
        AND ($2::text IS NULL OR p.locale = $2::text)
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
      JOIN index_pages p ON p.id = c.page_id
      CROSS JOIN tsq
      WHERE c.fts @@ tsq.query
        AND ($2::text IS NULL OR p.locale = $2::text)
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
    c.id, c.page_id, c.ordinal, c.heading_path, c.anchor, c.text,
    f.score::float8 AS score, f.vector_rank, f.text_rank,
    p.title, p.path, p.locale, p.updated_at
  FROM fused f
  JOIN index_chunks c ON c.id = f.chunk_id
  JOIN index_pages p ON p.id = c.page_id
  ORDER BY f.score DESC, c.page_id, c.ordinal
`

export async function searchChunks (
  db: Pool,
  queryEmbedding: string,
  query: string,
  locale: string | null,
  perList: number
): Promise<ChunkHit[]> {
  const { rows } = await db.query<{
    id: number, page_id: number, ordinal: number, heading_path: string, anchor: string, text: string,
    score: number, vector_rank: number | null, text_rank: number | null,
    title: string, path: string, locale: string, updated_at: Date
  }>(HYBRID_SQL, [queryEmbedding, locale, query, perList, RRF_K])

  return rows.map(row => ({
    chunkId: row.id,
    pageId: row.page_id,
    ordinal: row.ordinal,
    headingPath: row.heading_path,
    anchor: row.anchor,
    text: row.text,
    score: row.score,
    vectorRank: row.vector_rank,
    textRank: row.text_rank,
    title: row.title,
    path: row.path,
    locale: row.locale,
    updatedAt: row.updated_at.toISOString()
  }))
}

export async function chunkCount (db: Pool): Promise<number> {
  const { rows } = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM index_chunks')
  return Number(rows[0]?.count ?? 0)
}
