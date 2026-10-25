/**
 * Schema for the page index. Migrations run at startup, in order, and each
 * is recorded so it runs once.
 *
 * The embedding column is not here: its width depends on the embedding
 * model, which is only known once Ollama has answered. See
 * ensureEmbeddingColumn below.
 */
import type { Pool } from 'pg'

import { withTransaction } from './pool.js'

/** pgvector builds an HNSW index over at most this many dimensions. */
export const HNSW_MAX_DIMS = 2000

interface Migration {
  name: string
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    name: '001-extension',
    sql: 'CREATE EXTENSION IF NOT EXISTS vector'
  },
  {
    name: '002-meta',
    sql: `
      CREATE TABLE IF NOT EXISTS index_meta (
        id          boolean PRIMARY KEY DEFAULT true CHECK (id),
        embed_model text NOT NULL,
        embed_dims  integer NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `
  },
  {
    name: '003-pages',
    sql: `
      CREATE TABLE IF NOT EXISTS index_pages (
        id           integer PRIMARY KEY,
        path         text NOT NULL,
        locale       text NOT NULL,
        title        text NOT NULL DEFAULT '',
        description  text NOT NULL DEFAULT '',
        content_type text NOT NULL DEFAULT 'markdown',
        source_hash  text NOT NULL,
        updated_at   timestamptz NOT NULL,
        indexed_at   timestamptz NOT NULL DEFAULT now()
      )
    `
  },
  {
    name: '004-pages-path',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS index_pages_locale_path ON index_pages (locale, path)'
  },
  {
    name: '005-chunks',
    sql: `
      CREATE TABLE IF NOT EXISTS index_chunks (
        id           bigserial PRIMARY KEY,
        page_id      integer NOT NULL REFERENCES index_pages (id) ON DELETE CASCADE,
        ordinal      integer NOT NULL,
        heading_path text NOT NULL DEFAULT '',
        text         text NOT NULL,
        content_hash text NOT NULL,
        embed_model  text NOT NULL,
        tokens       integer NOT NULL DEFAULT 0,
        created_at   timestamptz NOT NULL DEFAULT now(),
        fts          tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
      )
    `
  },
  {
    name: '006-chunks-indexes',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS index_chunks_page_ordinal ON index_chunks (page_id, ordinal);
      CREATE INDEX IF NOT EXISTS index_chunks_hash ON index_chunks (page_id, content_hash);
      CREATE INDEX IF NOT EXISTS index_chunks_fts ON index_chunks USING gin (fts)
    `
  },
  {
    name: '007-queue',
    sql: `
      CREATE TABLE IF NOT EXISTS index_queue (
        page_id    integer PRIMARY KEY,
        event      text NOT NULL,
        path       text,
        locale     text,
        run_after  timestamptz NOT NULL,
        attempts   integer NOT NULL DEFAULT 0,
        last_error text,
        locked_at  timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS index_queue_due ON index_queue (run_after)
    `
  },
  {
    name: '008-chunk-anchor',
    sql: `ALTER TABLE index_chunks ADD COLUMN IF NOT EXISTS anchor text NOT NULL DEFAULT ''`
  },
  {
    // Uploaded files live in the same index as pages, so one search ranks
    // both. A chunk therefore belongs to a page or to a document, never to
    // both and never to neither.
    name: '009-documents',
    sql: `
      CREATE TABLE IF NOT EXISTS index_documents (
        id          integer PRIMARY KEY,
        path        text NOT NULL,
        file_name   text NOT NULL,
        ext         text NOT NULL DEFAULT '',
        mime        text NOT NULL DEFAULT '',
        doc_type    text NOT NULL DEFAULT '',
        file_size   bigint NOT NULL DEFAULT 0,
        updated_at  timestamptz NOT NULL,
        source_hash text NOT NULL DEFAULT '',
        status      text NOT NULL DEFAULT 'indexed',
        reason      text NOT NULL DEFAULT '',
        indexed_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS index_documents_path ON index_documents (path);

      ALTER TABLE index_chunks ALTER COLUMN page_id DROP NOT NULL;
      ALTER TABLE index_chunks
        ADD COLUMN IF NOT EXISTS document_id integer REFERENCES index_documents (id) ON DELETE CASCADE;
      ALTER TABLE index_chunks ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT '';
      ALTER TABLE index_chunks DROP CONSTRAINT IF EXISTS index_chunks_owner;
      ALTER TABLE index_chunks
        ADD CONSTRAINT index_chunks_owner CHECK (num_nonnulls(page_id, document_id) = 1);
      CREATE UNIQUE INDEX IF NOT EXISTS index_chunks_document_ordinal ON index_chunks (document_id, ordinal);
      CREATE INDEX IF NOT EXISTS index_chunks_document_hash ON index_chunks (document_id, content_hash);

      CREATE TABLE IF NOT EXISTS index_document_links (
        asset_path text NOT NULL,
        page_id    integer NOT NULL REFERENCES index_pages (id) ON DELETE CASCADE,
        PRIMARY KEY (asset_path, page_id)
      );
      CREATE INDEX IF NOT EXISTS index_document_links_page ON index_document_links (page_id);

      ALTER TABLE index_queue RENAME COLUMN page_id TO entity_id;
      ALTER TABLE index_queue ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'page';
      ALTER TABLE index_queue DROP CONSTRAINT IF EXISTS index_queue_pkey;
      ALTER TABLE index_queue ADD PRIMARY KEY (kind, entity_id);
    `
  },
  {
    // An image's text comes from three different places, and a reader has
    // to be told which: a chunk records where its text came from.
    name: '010-images',
    sql: `
      ALTER TABLE index_chunks ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT '';

      -- One description per image content, not per image: the same picture
      -- uploaded twice, or re-indexed, is never described twice.
      CREATE TABLE IF NOT EXISTS index_image_descriptions (
        content_hash  text PRIMARY KEY,
        model         text NOT NULL,
        text          text NOT NULL,
        input_tokens  integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS index_image_descriptions_day ON index_image_descriptions (created_at);

      -- The alt text and captions a page gives an image it shows.
      CREATE TABLE IF NOT EXISTS index_image_text (
        asset_path text NOT NULL,
        page_id    integer NOT NULL REFERENCES index_pages (id) ON DELETE CASCADE,
        alt        text NOT NULL DEFAULT '',
        caption    text NOT NULL DEFAULT '',
        PRIMARY KEY (asset_path, page_id)
      );
      CREATE INDEX IF NOT EXISTS index_image_text_page ON index_image_text (page_id);
    `
  },
  {
    // A page can be published and still not visible: Wiki.js honours a
    // publish window, and nothing fires an event when one closes. The
    // dates are kept here so a search can exclude a page the moment it
    // falls outside its window, without asking the wiki.
    name: '011-publish-window',
    sql: `
      ALTER TABLE index_pages ADD COLUMN IF NOT EXISTS publish_start timestamptz;
      ALTER TABLE index_pages ADD COLUMN IF NOT EXISTS publish_end   timestamptz;
      CREATE INDEX IF NOT EXISTS index_pages_window ON index_pages (publish_start, publish_end);
    `
  }
]

/** Pages indexed before 011 have no dates, so they have to be read again. */
export const WINDOW_MIGRATION = '011-publish-window'

/** Applying this one means the chunks have to be built again. */
export const ANCHOR_MIGRATION = '008-chunk-anchor'

export async function migrate (db: Pool): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS index_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const { rows } = await db.query<{ name: string }>('SELECT name FROM index_migrations')
  const applied = new Set(rows.map(row => row.name))
  const ran: string[] = []

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) { continue }
    await db.query(migration.sql)
    await db.query('INSERT INTO index_migrations (name) VALUES ($1)', [migration.name])
    ran.push(migration.name)
  }

  return ran
}

export interface IndexMeta {
  embedModel: string
  embedDims: number
}

export async function readMeta (db: Pool): Promise<IndexMeta | null> {
  const { rows } = await db.query<{ embed_model: string, embed_dims: number }>(
    'SELECT embed_model, embed_dims FROM index_meta WHERE id'
  )
  const row = rows[0]
  return row ? { embedModel: row.embed_model, embedDims: row.embed_dims } : null
}

/**
 * Make the embedding column match the model in use.
 *
 * pgvector needs a fixed width to build an HNSW index, and a vector from one
 * model means nothing to another, so changing the model empties the index and
 * rebuilds the column. Reconciliation then queues every page again.
 *
 * Returns true when everything was thrown away.
 */
export async function ensureEmbeddingColumn (
  db: Pool,
  model: string,
  dims: number
): Promise<{ reset: boolean }> {
  if (!Number.isInteger(dims) || dims < 1 || dims > HNSW_MAX_DIMS) {
    throw new Error(
      `"${model}" returns ${dims}-dimension vectors, and pgvector can only index up to ${HNSW_MAX_DIMS}. ` +
      'Choose a smaller embedding model in EMBED_MODEL.'
    )
  }

  const meta = await readMeta(db)
  const matches = meta !== null && meta.embedModel === model && meta.embedDims === dims
  if (matches && await hasEmbeddingColumn(db)) {
    return { reset: false }
  }

  const reset = meta !== null

  // One transaction: a failure part way through would otherwise leave the
  // index emptied and the column gone.
  await withTransaction(db, async client => {
    await client.query('DROP INDEX IF EXISTS index_chunks_embedding')
    await client.query('ALTER TABLE index_chunks DROP COLUMN IF EXISTS embedding')
    await client.query('TRUNCATE index_chunks')
    if (reset) {
      // Everything has to be read and embedded again.
      await client.query('TRUNCATE index_pages CASCADE')
      await client.query('TRUNCATE index_documents CASCADE')
    }
    await client.query(`ALTER TABLE index_chunks ADD COLUMN embedding vector(${dims})`)
    await client.query(`
      CREATE INDEX index_chunks_embedding ON index_chunks
      USING hnsw (embedding vector_cosine_ops)
    `)
    await client.query(`
      INSERT INTO index_meta (id, embed_model, embed_dims, updated_at)
      VALUES (true, $1, $2, now())
      ON CONFLICT (id) DO UPDATE SET embed_model = $1, embed_dims = $2, updated_at = now()
    `, [model, dims])
  })

  return { reset }
}

async function hasEmbeddingColumn (db: Pool): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'index_chunks' AND column_name = 'embedding'
    ) AS exists
  `)
  return rows[0]?.exists === true
}
