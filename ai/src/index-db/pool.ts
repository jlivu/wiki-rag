import pg from 'pg'

/**
 * The index database: Postgres with pgvector, on the Docker network only.
 * One pool for the whole service.
 */
let pool: pg.Pool | null = null

export function getPool (databaseUrl: string): pg.Pool {
  if (pool === null) {
    pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
    // A dropped connection must not take the process down with it.
    pool.on('error', () => {})
  }
  return pool
}

export async function closePool (): Promise<void> {
  const current = pool
  pool = null
  if (current) { await current.end() }
}

/** Run a unit of work in one transaction. */
export async function withTransaction<T> (
  db: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* the connection is already gone */ }
    throw err
  } finally {
    client.release()
  }
}

export type { Pool, PoolClient } from 'pg'
