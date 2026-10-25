/**
 * What search_wiki asks when the index is available.
 *
 * Chunks are fused by reciprocal rank fusion, grouped back into pages, and
 * then — before anything reaches the model — checked page by page against
 * Wiki.js as the reader who asked. The index was built with the admin key,
 * so it holds pages some readers may not see.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'

import { chunkCount, searchChunks, type ChunkHit } from '../index-db/search.js'
import type { PermissionCache } from '../wiki/permission-cache.js'
import { WikiClient } from '../wiki/client.js'

import { toVectorLiteral, type Embedder } from './embeddings.js'

/** Candidates taken from each of the two searches before fusion. */
const PER_LIST = 30
/** At most two chunks of one page are quoted back. */
const SNIPPETS_PER_PAGE = 2
const SNIPPET_CHARS = 420
/** Permission checks cost a request each, so cap how many are attempted. */
const MAX_CHECKS = 24

export interface RetrievedPage {
  title: string
  path: string
  locale: string
  heading: string
  snippet: string
  updatedAt: string
  score: number
}

export interface RetrievalResult {
  results: RetrievedPage[]
  /** How many pages the reader was not allowed to see. */
  filtered: number
  checked: number
}

export class Retriever {
  readonly #db: Pool
  readonly #embedder: Embedder
  readonly #permissions: PermissionCache
  readonly #log: FastifyBaseLogger

  constructor (db: Pool, embedder: Embedder, permissions: PermissionCache, log: FastifyBaseLogger) {
    this.#db = db
    this.#embedder = embedder
    this.#permissions = permissions
    this.#log = log
  }

  /** False when there is nothing indexed yet; the caller then falls back. */
  async hasContent (): Promise<boolean> {
    return (await chunkCount(this.#db)) > 0
  }

  async search (
    query: string,
    locale: string | null,
    limit: number,
    reader: WikiClient,
    readerToken: string | null
  ): Promise<RetrievalResult> {
    const [vector] = await this.#embedder.embed([query])
    if (!vector) { throw new Error('the query could not be embedded') }

    const hits = await searchChunks(this.#db, toVectorLiteral(vector), query, locale, PER_LIST)
    const pages = groupByPage(hits)

    // More candidates than will be returned, so enough survive the filter.
    const results: RetrievedPage[] = []
    let filtered = 0
    let checked = 0

    for (const page of pages) {
      if (results.length >= limit || checked >= MAX_CHECKS) { break }
      checked += 1
      if (await this.#canRead(reader, readerToken, page.path, page.locale)) {
        results.push(page)
      } else {
        filtered += 1
      }
    }

    return { results, filtered, checked }
  }

  /** The same request get_page makes, so the answer is the same answer. */
  async #canRead (
    reader: WikiClient,
    token: string | null,
    path: string,
    locale: string
  ): Promise<boolean> {
    const cached = this.#permissions.get(token, locale, path)
    if (cached !== undefined) { return cached }

    let readable = false
    try {
      await reader.fetchPage(path, locale)
      readable = true
    } catch {
      readable = false
    }
    this.#permissions.set(token, locale, path, readable)
    return readable
  }
}

/** One entry per page, carrying its best chunks. */
function groupByPage (hits: ChunkHit[]): RetrievedPage[] {
  const byPage = new Map<number, { hits: ChunkHit[], score: number }>()
  for (const hit of hits) {
    const entry = byPage.get(hit.pageId) ?? { hits: [], score: 0 }
    entry.hits.push(hit)
    // A page is worth the sum of its matching chunks, so a page that
    // matches in two places outranks one that matches in one.
    entry.score += hit.score
    byPage.set(hit.pageId, entry)
  }

  return [...byPage.values()]
    .map(entry => {
      const best = entry.hits.slice(0, SNIPPETS_PER_PAGE)
      const first = best[0] as ChunkHit
      return {
        title: first.title,
        path: first.path,
        locale: first.locale,
        heading: first.headingPath,
        snippet: best.map(hit => snippetOf(hit)).join('\n\n…\n\n'),
        updatedAt: first.updatedAt,
        score: Number(entry.score.toFixed(6))
      }
    })
    .sort((a, b) => b.score - a.score)
}

/** Chunk text carries a "Title › Heading" prefix; the snippet is the body. */
function snippetOf (hit: ChunkHit): string {
  const body = hit.text.includes('\n\n') ? hit.text.slice(hit.text.indexOf('\n\n') + 2) : hit.text
  const clean = body.trim()
  if (clean.length <= SNIPPET_CHARS) { return clean }
  const cut = clean.slice(0, SNIPPET_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > SNIPPET_CHARS * 0.6 ? lastSpace : SNIPPET_CHARS).trimEnd()}…`
}
