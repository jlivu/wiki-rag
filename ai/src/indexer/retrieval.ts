/**
 * What search_wiki asks when the index is available.
 *
 * Chunks are fused by reciprocal rank fusion, grouped back into the page or
 * the file they came from, and then — before anything reaches the model —
 * checked one by one against Wiki.js as the reader who asked. The index was
 * built with the admin key, so it holds things some readers may not see.
 *
 * Pages and uploaded documents are ranked against each other in one list.
 * A page is checked by fetching it as the reader; a file by asking Wiki.js
 * for it as the reader, which applies `read:assets` to its path.
 *
 * That check is also how the index learns it is stale. Wiki.js answers 403
 * for something the reader may not see and 404 for something that is not
 * there, so a result the wiki no longer has is dropped and queued to be
 * read again — see stale.ts.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'

import { chunkCount, searchChunks, type ChunkHit } from '../index-db/search.js'
import { linkingPages, type LinkingPage } from '../index-db/store.js'
import type { PermissionCache, ResourceKind } from '../wiki/permission-cache.js'
import { WikiClient, WikiError } from '../wiki/client.js'

import { toVectorLiteral, type Embedder } from './embeddings.js'
import { forgetStaleDocument, forgetStalePage } from './stale.js'

/** Candidates taken from each of the two searches before fusion. */
const PER_LIST = 30
/** At most two chunks of one page or file are quoted back. */
const SNIPPETS_PER_PAGE = 2
const SNIPPET_CHARS = 420
/** Permission checks cost a request each, so cap how many are attempted. */
const MAX_CHECKS = 24
/** Pages named under "Linked from", at most, and only ones the reader may see. */
const MAX_LINKS = 3

interface RetrievedBase {
  title: string
  path: string
  snippet: string
  updatedAt: string
  score: number
  /** Wiki.js's section anchor, or "#page=4" in a PDF. */
  anchor: string
}

export interface RetrievedPage extends RetrievedBase {
  kind: 'page'
  /** The indexed page's id, so a stale hit can be queued by id. */
  id: number
  locale: string
  /** The heading path of the best chunk, e.g. "Procedure › 5. Verify". */
  heading: string
}

export interface RetrievedDocument extends RetrievedBase {
  kind: 'document'
  id: number
  fileName: string
  /** pdf, docx, xlsx, pptx, csv. */
  docType: string
  mime: string
  fileSize: number
  /** Where in the file: "Page 4", "Sheet \"Budget\" rows 12–40". */
  location: string
  /** For an image: 'ocr', 'alt' or 'description', so a generated
   *  description can be labelled as one. */
  origin: string
  /** The pages that link to this file, as far as the reader may see them. */
  linkedFrom: Array<{ title: string, path: string, locale: string }>
}

export type RetrievedItem = RetrievedPage | RetrievedDocument

export interface RetrievalResult {
  results: RetrievedItem[]
  /** How many pages or files the reader was not allowed to see. */
  filtered: number
  /** How many the wiki no longer has. They are queued for removal. */
  stale: number
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
    const candidates = group(hits)

    // More candidates than will be returned, so enough survive the filter.
    const results: RetrievedItem[] = []
    let filtered = 0
    let stale = 0
    let checked = 0

    for (const item of candidates) {
      if (results.length >= limit || checked >= MAX_CHECKS) { break }
      checked += 1
      const access = await this.#canRead(reader, readerToken, item)
      if (access === 'missing') {
        stale += 1
        await this.#forget(item)
        continue
      }
      if (access === 'no') {
        filtered += 1
        continue
      }
      results.push(
        item.kind === 'document'
          ? { ...item, linkedFrom: await this.#linkedFrom(reader, readerToken, item.path) }
          : item
      )
    }

    return { results, filtered, stale, checked }
  }

  /** Whether this reader may open one candidate, page or file. */
  async #canRead (reader: WikiClient, token: string | null, item: RetrievedItem): Promise<Access> {
    const kind: ResourceKind = item.kind
    const locale = item.kind === 'page' ? item.locale : ''
    const cached = this.#permissions.get(token, kind, locale, item.path)
    // The cache remembers yes and no. A hit that turned out not to exist
    // was cached as "no", which is true for this reader either way, and
    // its removal is already queued.
    if (cached !== undefined) { return cached ? 'yes' : 'no' }

    let access: Access = 'no'
    if (item.kind === 'page') {
      // The same request get_page makes, so the answer is the same answer.
      try {
        await reader.fetchPage(item.path, item.locale)
        access = 'yes'
      } catch (err) {
        access = err instanceof WikiError && err.status === 404 ? 'missing' : 'no'
      }
    } else {
      access = await reader.canReadAsset(item.path)
    }

    this.#permissions.set(token, kind, locale, item.path, access === 'yes')
    return access
  }

  /** The wiki does not have this any more, so neither should the index. */
  async #forget (item: RetrievedItem): Promise<void> {
    try {
      if (item.kind === 'page') {
        await forgetStalePage(this.#db, item.id, item.path, item.locale, this.#log)
      } else {
        await forgetStaleDocument(this.#db, item.id, item.path, this.#log)
      }
    } catch (err) {
      // Never let housekeeping break an answer.
      this.#log.warn({ err, path: item.path }, 'a stale search result could not be queued for removal')
    }
  }

  /**
   * The pages that link to a file — but only the ones this reader may
   * open, since a title is as much a leak as a snippet.
   */
  async #linkedFrom (
    reader: WikiClient,
    token: string | null,
    assetPath: string
  ): Promise<Array<{ title: string, path: string, locale: string }>> {
    let pages: LinkingPage[]
    try {
      pages = await linkingPages(this.#db, assetPath, MAX_LINKS + 2)
    } catch (err) {
      this.#log.warn({ err, assetPath }, 'the pages linking to a file could not be read')
      return []
    }

    const visible: Array<{ title: string, path: string, locale: string }> = []
    for (const page of pages) {
      if (visible.length >= MAX_LINKS) { break }
      const item: RetrievedPage = {
        kind: 'page',
        id: page.id,
        title: page.title,
        path: page.path,
        locale: page.locale,
        heading: '',
        anchor: '',
        snippet: '',
        updatedAt: '',
        score: 0
      }
      if (await this.#canRead(reader, token, item)) {
        visible.push({ title: page.title || page.path, path: page.path, locale: page.locale })
      }
    }
    return visible
  }
}

/** yes: show it. no: this reader may not. missing: the wiki has not got it. */
type Access = 'yes' | 'no' | 'missing'

/** One entry per page or file, carrying its best chunks. */
function group (hits: ChunkHit[]): RetrievedItem[] {
  const byOwner = new Map<string, { hits: ChunkHit[], score: number }>()
  for (const hit of hits) {
    const key = `${hit.kind}:${hit.ownerId}`
    const entry = byOwner.get(key) ?? { hits: [], score: 0 }
    entry.hits.push(hit)
    // Something is worth the sum of its matching chunks, so a page that
    // matches in two places outranks one that matches in one.
    entry.score += hit.score
    byOwner.set(key, entry)
  }

  return [...byOwner.values()]
    .map(entry => {
      const best = entry.hits.slice(0, SNIPPETS_PER_PAGE)
      const first = best[0] as ChunkHit
      const snippet = best.map(hit => snippetOf(hit)).join('\n\n…\n\n')
      const score = Number(entry.score.toFixed(6))

      if (first.kind === 'document') {
        return {
          kind: 'document' as const,
          id: first.ownerId,
          title: first.fileName,
          fileName: first.fileName,
          path: first.path,
          docType: first.docType,
          mime: first.mime,
          fileSize: first.fileSize,
          location: first.location,
          origin: first.origin,
          anchor: first.anchor,
          snippet,
          updatedAt: first.updatedAt,
          score,
          linkedFrom: []
        }
      }

      return {
        kind: 'page' as const,
        id: first.ownerId,
        title: first.title,
        path: first.path,
        locale: first.locale,
        heading: first.headingPath,
        anchor: first.anchor,
        snippet,
        updatedAt: first.updatedAt,
        score
      }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * Chunk text carries a "Title › Heading" prefix; the snippet is the body.
 *
 * A snippet is read at a glance in a card, so the markup that reads worst
 * there is taken out: fenced code is dropped and table rows are flattened
 * to one line. A chunk that is nothing but code keeps its code, because
 * showing something beats showing nothing.
 */
function snippetOf (hit: ChunkHit): string {
  const body = hit.text.includes('\n\n') ? hit.text.slice(hit.text.indexOf('\n\n') + 2) : hit.text
  return clip(readable(body) || body.trim())
}

function readable (body: string): string {
  const kept: string[] = []
  let fence: string | null = null

  for (const line of body.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch?.[1]) {
      fence = fence === null ? fenceMatch[1][0] ?? '`' : null
      continue
    }
    if (fence !== null) { continue }

    const clean = line.trim().replace(/^>\s?/, '')
    // The row of dashes under a table's header says nothing on its own.
    if (clean.length === 0 || /^\|?[\s:|-]+\|?$/.test(clean)) { continue }
    kept.push(
      clean.startsWith('|')
        ? clean.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()).filter(Boolean).join(' · ')
        : clean
    )
  }

  return kept.join(' ').trim()
}

function clip (text: string): string {
  if (text.length <= SNIPPET_CHARS) { return text }
  const cut = text.slice(0, SNIPPET_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > SNIPPET_CHARS * 0.6 ? lastSpace : SNIPPET_CHARS).trimEnd()}…`
}
