/**
 * The indexer: a durable queue, a worker that drains it, and a
 * reconciliation pass that compares the index with Wiki.js.
 *
 * Everything is best effort from the wiki's point of view. A page save
 * posts an event and carries on; if the indexer is down, reconciliation
 * picks the page up later.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'

import type { Config } from '../config.js'
import {
  ANCHOR_MIGRATION, WINDOW_MIGRATION, ensureEmbeddingColumn, migrate, readMeta
} from '../index-db/migrate.js'
import { getPool } from '../index-db/pool.js'
import {
  claim, complete, enqueue, enqueueIfAbsent, fail, queueDepth,
  type IndexEvent, type QueuedJob
} from '../index-db/queue.js'
import {
  emptyPage, forgetOrphanedDescriptions, indexCounts, indexedIds, listIndexedDocuments,
  listIndexedPages, pagesInWindowWithoutChunks, pagesOutsideWindow, readStats,
  removeDocument, type IndexStats
} from '../index-db/store.js'
import { WikiAdminClient } from '../wiki/admin-client.js'

import { PermissionCache } from '../wiki/permission-cache.js'

import { createImageDescriber, type ImageDescriber } from '../images/describe.js'

import { AssetDirectory } from './asset-directory.js'
import { runDocumentJob } from './document-job.js'
import { Embedder } from './embeddings.js'
import { forgetPage } from './forget.js'
import { runJob } from './job.js'
import type { LinkScanOptions } from './links.js'
import { Retriever } from './retrieval.js'

const IDLE_POLL_MS = 1000
const RECONCILE_START_DELAY_MS = 5000

export interface IndexerStatus {
  enabled: boolean
  ready: boolean
  reason?: string
  queued: number
  stats: IndexStats | null
}

/** What one reconciliation pass did, kept for the status report. */
export interface ReconcileReport {
  at: string
  trigger: string
  ms: number
  ok: boolean
  /** Only on a failure. */
  error?: string
  queued: number
  removed: number
  queuedFiles: number
  removedFiles: number
  /** Pages emptied because their publish window is closed. */
  emptied: number
  /** Pages queued again because their window has opened. */
  reopened: number
}

/**
 * The full picture: what the index holds, what the wiki holds, and
 * everything that does not line up between them.
 */
export interface IndexReport {
  enabled: boolean
  ready: boolean
  reason?: string
  queued: number
  embedding: { model: string | null, dims: number | null }
  index: Awaited<ReturnType<typeof indexCounts>> & { lastIndexedAt: string | null }
  wiki: { pages: number, files: number } | null
  /** Everything out of step, and empty when nothing is. */
  drift: {
    pagesMissingFromIndex: number
    pagesOnlyInIndex: number
    filesMissingFromIndex: number
    filesOnlyInIndex: number
    pagesOutsideWindow: number
    pagesWithoutChunks: number
    note: string[]
  }
  lastReconcile: ReconcileReport | null
  inStep: boolean
}

export class Indexer {
  readonly #config: Config
  readonly #log: FastifyBaseLogger
  readonly #db: Pool
  readonly #wiki: WikiAdminClient
  readonly #embedder: Embedder
  readonly #retriever: Retriever
  readonly #assets: AssetDirectory
  readonly #describer: ImageDescriber
  /** Shared with the retriever, so a removal can empty it. */
  readonly #permissions = new PermissionCache()

  #ready = false
  #reason: string | undefined
  #stopped = false
  #workerTimer: NodeJS.Timeout | null = null
  #reconcileTimer: NodeJS.Timeout | null = null
  #startupTimer: NodeJS.Timeout | null = null
  #draining = false
  #lastReconcile: ReconcileReport | null = null

  constructor (config: Config, log: FastifyBaseLogger) {
    this.#config = config
    this.#log = log.child({ module: 'indexer' })
    this.#db = getPool(config.index.databaseUrl)
    this.#wiki = new WikiAdminClient(config.wikiUrl, config.index.wikiApiKey)
    this.#embedder = new Embedder(config.llm.ollamaUrl, config.index.embedModel)
    this.#assets = new AssetDirectory(this.#wiki)
    this.#describer = createImageDescriber(config)
    this.#retriever = new Retriever(this.#db, this.#embedder, this.#permissions, this.#log)
  }

  /** Where an asset link in a page points, and what is not a file. */
  get #links (): LinkScanOptions {
    return {
      origins: [this.#config.wikiUrl, this.#config.wikiPublicUrl].filter(url => url.length > 0),
      pageExtensions: this.#config.index.pageExtensions
    }
  }

  /**
   * Images whose text came from a page that has changed or gone.
   *
   * A changed caption makes the image stale, not the page, so the image
   * is queued in its own right.
   */
  readonly #requeueDocuments = async (ids: number[]): Promise<void> => {
    for (const id of ids) {
      await enqueueIfAbsent(this.#db, { kind: 'document', entityId: id, event: 'updated' })
    }
  }

  /** What search_wiki queries. It decides for itself whether it can
   *  answer, so the agent does not have to know the indexer's state. */
  get retriever (): Retriever {
    return this.#retriever
  }

  /** The index database, for reading a document's extracted text. */
  get database (): Pool {
    return this.#db
  }

  get enabled (): boolean {
    return this.#config.index.wikiApiKey.length > 0
  }

  /** Schema first, then the embedding width, then the loops. */
  async start (): Promise<void> {
    if (!this.enabled) {
      this.#reason = 'WIKI_API_KEY is not set'
      this.#log.warn('the indexer is off: WIKI_API_KEY is not set')
      return
    }

    let rebuildChunks = false
    let refreshWindows = false
    try {
      const ran = await migrate(this.#db)
      if (ran.length > 0) { this.#log.info({ migrations: ran }, 'index schema migrated') }
      // Existing chunks predate section anchors, so they have to be built
      // again. The text is unchanged, so no embedding is recomputed.
      rebuildChunks = ran.includes(ANCHOR_MIGRATION)
      // Pages indexed before the publish window was known have no dates,
      // which reads as "no window at all". Until each one has been looked
      // at again, a closed window would go unnoticed.
      refreshWindows = ran.includes(WINDOW_MIGRATION)
    } catch (err) {
      this.#reason = 'the index database is unreachable'
      this.#log.error({ err }, 'the index database could not be prepared')
      return
    }

    await this.#prepareEmbeddings()

    this.#workerTimer = setTimeout(() => { void this.#drain() }, IDLE_POLL_MS)
    this.#startupTimer = setTimeout(() => {
      void (async () => {
        if (rebuildChunks) {
          await this.reindexEverything()
          return
        }
        // Before reconciling, so the first pass already sees real dates.
        if (refreshWindows) { await this.#queueEveryIndexedPage() }
        await this.reconcile('startup')
      })()
    }, RECONCILE_START_DELAY_MS)
    if (rebuildChunks) { this.#log.info('re-indexing: chunks now carry section anchors') }
    this.#log.info({
      describer: this.#describer.id,
      ...(this.#describer.id === 'off' ? {} : { model: this.#describer.model }),
      dailyLimit: this.#config.images.describeDailyLimit,
      excluded: this.#config.images.describeExclude
    }, 'image indexing ready')

    const everyMs = Math.max(1, this.#config.index.reconcileMinutes) * 60_000
    this.#reconcileTimer = setInterval(() => { void this.reconcile('scheduled') }, everyMs)
  }

  async stop (): Promise<void> {
    this.#stopped = true
    for (const timer of [this.#workerTimer, this.#startupTimer]) {
      if (timer) { clearTimeout(timer) }
    }
    if (this.#reconcileTimer) { clearInterval(this.#reconcileTimer) }
  }

  /**
   * Ask Ollama how wide this model's vectors are and make the column match.
   * A different model means every stored vector is meaningless, so the
   * index is emptied and reconciliation fills it again.
   */
  async #prepareEmbeddings (): Promise<void> {
    try {
      const dims = await this.#embedder.dimensions()
      const { reset } = await ensureEmbeddingColumn(this.#db, this.#embedder.model, dims)
      this.#ready = true
      this.#reason = undefined
      this.#log.info(
        { model: this.#embedder.model, dims, reset },
        reset ? 'the embedding model changed; re-indexing everything' : 'embeddings ready'
      )
    } catch (err) {
      this.#ready = false
      this.#reason = err instanceof Error ? err.message : 'embeddings are unavailable'
      this.#log.warn({ err }, 'embeddings are not available yet; will retry')
    }
  }

  async enqueuePageEvent (event: {
    event: IndexEvent
    id: number
    path?: string | null
    locale?: string | null
  }): Promise<void> {
    await enqueue(
      this.#db,
      { kind: 'page', entityId: event.id, event: event.event, path: event.path ?? null, locale: event.locale ?? null },
      this.#config.index.debounceSeconds
    )
  }

  /** A file was uploaded, renamed or deleted in the asset manager. */
  async enqueueAssetEvent (event: {
    event: IndexEvent
    id: number
    path?: string | null
  }): Promise<void> {
    await enqueue(
      this.#db,
      { kind: 'document', entityId: event.id, event: event.event, path: event.path ?? null },
      this.#config.index.debounceSeconds
    )
  }

  /** Compare Wiki.js's page list with the index. On an empty index this is
   *  the backfill. */
  async reconcile (trigger: string): Promise<{ queued: number, removed: number } | null> {
    if (!this.enabled || this.#stopped) { return null }
    if (!this.#ready) { await this.#prepareEmbeddings() }
    if (!this.#ready) { return null }

    const startedAt = Date.now()
    try {
      const [wikiPages, indexedPages, wikiAssets, indexedDocuments] = await Promise.all([
        this.#wiki.listPages(),
        listIndexedPages(this.#db),
        this.#assets.list(true),
        listIndexedDocuments(this.#db)
      ])

      const live = new Map(wikiPages.filter(page => page.isPublished).map(page => [page.id, page]))
      const have = new Map(indexedPages.map(page => [page.id, page.updatedAt]))

      let queued = 0
      for (const [id, page] of live) {
        const seen = have.get(id)
        if (seen === undefined || !sameInstant(seen, page.updatedAt)) {
          await enqueueIfAbsent(this.#db, { kind: 'page', entityId: id, event: 'updated', path: page.path, locale: page.locale })
          queued += 1
        }
      }

      // A page can leave the wiki without an event ever reaching us — a
      // failed save that unpublished it, a delete while this service was
      // stopped — so this path has to clean up after a page exactly as
      // the delete job does, images included.
      let removed = 0
      let requeuedImages = 0
      for (const id of have.keys()) {
        if (!live.has(id)) {
          requeuedImages += await forgetPage(this.#db, id, this.#requeueDocuments)
          removed += 1
        }
      }

      // Uploaded files, the same way. A file that was looked at and left
      // out — an image, one too large — stays recorded, so it is not
      // queued again every half hour.
      const liveFiles = new Map(wikiAssets.map(asset => [asset.id, asset]))
      const haveFiles = new Map(indexedDocuments.map(document => [document.id, document]))

      let queuedFiles = 0
      for (const [id, asset] of liveFiles) {
        const seen = haveFiles.get(id)
        const changed = seen === undefined ||
          seen.path !== asset.path ||
          seen.fileSize !== asset.fileSize ||
          !sameInstant(seen.updatedAt, asset.updatedAt)
        if (changed) {
          await enqueueIfAbsent(this.#db, { kind: 'document', entityId: id, event: 'updated', path: asset.path })
          queuedFiles += 1
        }
      }

      let removedFiles = 0
      let forgottenDescriptions = 0
      for (const id of haveFiles.keys()) {
        if (!liveFiles.has(id)) {
          forgottenDescriptions += await removeDocument(this.#db, id)
          removedFiles += 1
        }
      }

      const { emptied, reopened } = await this.#reconcileWindows()
      if (removed + removedFiles + emptied > 0) { this.#permissions.clear() }

      // A description outlives the file it was written for only if
      // something went wrong, because removeDocument takes its own with
      // it. The sweep runs when the queue is empty, so a re-index — which
      // empties the tables and fills them again — never loses the cache
      // it is meant to reuse.
      if (queued + queuedFiles === 0 && await queueDepth(this.#db) === 0) {
        forgottenDescriptions += await forgetOrphanedDescriptions(this.#db)
      }

      this.#lastReconcile = {
        at: new Date().toISOString(),
        trigger,
        ms: Date.now() - startedAt,
        ok: true,
        queued,
        removed,
        queuedFiles,
        removedFiles,
        emptied,
        reopened
      }

      this.#log.info({
        trigger,
        wikiPages: live.size,
        indexed: have.size,
        queued,
        removed,
        wikiFiles: liveFiles.size,
        indexedFiles: haveFiles.size,
        queuedFiles,
        removedFiles,
        ...(emptied > 0 ? { emptied } : {}),
        ...(reopened > 0 ? { reopened } : {}),
        ...(requeuedImages > 0 ? { requeuedImages } : {}),
        ...(forgottenDescriptions > 0 ? { forgottenDescriptions } : {}),
        ms: Date.now() - startedAt
      }, 'reconciled')
      return { queued: queued + queuedFiles, removed: removed + removedFiles }
    } catch (err) {
      this.#lastReconcile = {
        at: new Date().toISOString(),
        trigger,
        ms: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        queued: 0,
        removed: 0,
        queuedFiles: 0,
        removedFiles: 0,
        emptied: 0,
        reopened: 0
      }
      this.#log.warn({ err, trigger }, 'reconciliation failed')
      return null
    }
  }

  /**
   * Publish windows, which no event ever reports.
   *
   * A page whose window has closed keeps its row — the dates are how we
   * know to read it again — but loses everything derived from it, so it
   * cannot be searched or cited. A page whose window has opened again is
   * queued to be read afresh.
   */
  async #reconcileWindows (): Promise<{ emptied: number, reopened: number }> {
    let emptied = 0
    for (const page of await pagesOutsideWindow(this.#db)) {
      const chunks = await emptyPage(this.#db, page.id)
      if (chunks > 0) {
        emptied += 1
        this.#log.info(
          { pageId: page.id, path: page.path, reason: page.reason, chunks },
          'page hidden: its publish window is closed'
        )
      }
    }

    let reopened = 0
    for (const id of await pagesInWindowWithoutChunks(this.#db)) {
      await enqueueIfAbsent(this.#db, { kind: 'page', entityId: id, event: 'updated' })
      reopened += 1
    }
    if (reopened > 0) { this.#log.info({ pages: reopened }, 'pages back inside their publish window') }

    return { emptied, reopened }
  }

  /**
   * Read every indexed page again, without throwing anything away.
   *
   * Used after a migration that adds something the index cannot work out
   * for itself. A page whose text has not changed costs one GraphQL read
   * and no embeddings.
   */
  async #queueEveryIndexedPage (): Promise<void> {
    const pages = await listIndexedPages(this.#db)
    for (const page of pages) {
      await enqueueIfAbsent(this.#db, { kind: 'page', entityId: page.id, event: 'updated' })
    }
    if (pages.length > 0) {
      this.#log.info({ pages: pages.length }, 'reading every page again to record its publish window')
    }
  }

  /** Throw the index away and build it again. */
  async reindexEverything (): Promise<{ queued: number }> {
    if (!this.enabled) { return { queued: 0 } }
    await this.#db.query('TRUNCATE index_pages CASCADE')
    await this.#db.query('TRUNCATE index_documents CASCADE')
    const result = await this.reconcile('reindex')
    return { queued: result?.queued ?? 0 }
  }

  async status (): Promise<IndexerStatus> {
    if (!this.enabled) {
      return { enabled: false, ready: false, reason: this.#reason, queued: 0, stats: null }
    }
    try {
      const [queued, stats, meta] = await Promise.all([
        queueDepth(this.#db),
        readStats(this.#db),
        readMeta(this.#db)
      ])
      return {
        enabled: true,
        ready: this.#ready,
        ...(this.#reason ? { reason: this.#reason } : {}),
        queued,
        stats: { ...stats, embedModel: meta?.embedModel ?? stats.embedModel }
      }
    } catch {
      return { enabled: true, ready: false, reason: 'the index database is unreachable', queued: 0, stats: null }
    }
  }

  /**
   * The index measured against the wiki.
   *
   * `/ai/health` deliberately does not call this: comparing means asking
   * Wiki.js for its whole page list and walking its asset folders, which
   * is an administrator's question, not something to do on every panel
   * load. Without `compare` it reports the index's own counts only.
   */
  async report (compare = true): Promise<IndexReport> {
    const base = {
      enabled: this.enabled,
      ready: this.#ready,
      ...(this.#reason ? { reason: this.#reason } : {})
    }

    if (!this.enabled) {
      return {
        ...base,
        queued: 0,
        embedding: { model: null, dims: null },
        index: { ...emptyCounts(), lastIndexedAt: null },
        wiki: null,
        drift: { ...noDrift(), note: ['the indexer is off: WIKI_API_KEY is not set'] },
        lastReconcile: this.#lastReconcile,
        inStep: false
      }
    }

    const [queued, counts, stats, meta, outside] = await Promise.all([
      queueDepth(this.#db),
      indexCounts(this.#db),
      readStats(this.#db),
      readMeta(this.#db),
      pagesOutsideWindow(this.#db)
    ])

    const note: string[] = []
    let wiki: { pages: number, files: number } | null = null
    let pagesMissingFromIndex = 0
    let pagesOnlyInIndex = 0
    let filesMissingFromIndex = 0
    let filesOnlyInIndex = 0

    if (compare) {
      try {
        const [wikiPages, wikiAssets, mine] = await Promise.all([
          this.#wiki.listPages(),
          this.#assets.list(true),
          indexedIds(this.#db)
        ])
        const livePages = wikiPages.filter(page => page.isPublished).map(page => page.id)
        const indexedPages = new Set(mine.pages)
        const indexedDocs = new Set(mine.documents)
        const liveFiles = wikiAssets.map(asset => asset.id)

        wiki = { pages: livePages.length, files: liveFiles.length }
        pagesMissingFromIndex = livePages.filter(id => !indexedPages.has(id)).length
        pagesOnlyInIndex = mine.pages.filter(id => !new Set(livePages).has(id)).length
        filesMissingFromIndex = liveFiles.filter(id => !indexedDocs.has(id)).length
        filesOnlyInIndex = mine.documents.filter(id => !new Set(liveFiles).has(id)).length
      } catch (err) {
        note.push(`the wiki could not be asked what it holds: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // A page emptied by its publish window has no chunks on purpose, so
    // it is not also counted as a page that is missing its content.
    const hidden = outside.length
    const withoutChunks = Math.max(0, counts.pagesWithoutChunks - hidden)

    if (pagesOnlyInIndex > 0) { note.push(`${pagesOnlyInIndex} page(s) in the index the wiki does not have`) }
    if (filesOnlyInIndex > 0) { note.push(`${filesOnlyInIndex} file(s) in the index the wiki does not have`) }
    if (pagesMissingFromIndex > 0) { note.push(`${pagesMissingFromIndex} page(s) the wiki has that the index does not`) }
    if (filesMissingFromIndex > 0) { note.push(`${filesMissingFromIndex} file(s) the wiki has that the index does not`) }
    if (withoutChunks > 0) { note.push(`${withoutChunks} indexed page(s) with no chunks`) }
    if (hidden > 0) { note.push(`${hidden} page(s) held back by a publish window`) }
    if (queued > 0) { note.push(`${queued} job(s) still queued`) }
    if (this.#lastReconcile && !this.#lastReconcile.ok) { note.push('the last reconciliation failed') }
    if (!this.#lastReconcile) { note.push('no reconciliation has run yet') }
    if (!this.#ready) { note.push(this.#reason ?? 'the indexer is not ready') }

    return {
      ...base,
      queued,
      embedding: { model: meta?.embedModel ?? stats.embedModel, dims: meta?.embedDims ?? stats.embedDims },
      index: { ...counts, lastIndexedAt: stats.lastIndexedAt },
      wiki,
      drift: {
        pagesMissingFromIndex,
        pagesOnlyInIndex,
        filesMissingFromIndex,
        filesOnlyInIndex,
        pagesOutsideWindow: hidden,
        pagesWithoutChunks: withoutChunks,
        note
      },
      lastReconcile: this.#lastReconcile,
      // A queued job and a closed window are both normal, so neither
      // counts against being in step; a difference with the wiki does.
      inStep: this.#ready &&
        pagesMissingFromIndex === 0 && pagesOnlyInIndex === 0 &&
        filesMissingFromIndex === 0 && filesOnlyInIndex === 0 &&
        withoutChunks === 0
    }
  }

  /** Take one job, then come back promptly if there may be more. */
  async #drain (): Promise<void> {
    if (this.#stopped || this.#draining) { return }
    this.#draining = true
    let delay = IDLE_POLL_MS

    try {
      if (!this.#ready) {
        await this.#prepareEmbeddings()
        if (!this.#ready) { return }
      }

      const job = await claim(this.#db)
      if (job) {
        await this.#process(job)
        delay = 0
      }
    } catch (err) {
      this.#log.warn({ err }, 'the indexer could not take a job')
    } finally {
      this.#draining = false
      if (!this.#stopped) {
        this.#workerTimer = setTimeout(() => { void this.#drain() }, delay)
      }
    }
  }

  async #process (job: QueuedJob): Promise<void> {
    const startedAt = Date.now()
    const what = job.kind === 'document' ? { documentId: job.entityId } : { pageId: job.entityId }
    try {
      const outcome = job.kind === 'document'
        ? await runDocumentJob(this.#db, this.#wiki, this.#embedder, job, {
          maxBytes: this.#config.index.maxDocumentBytes,
          pageExtensions: this.#config.index.pageExtensions,
          findAsset: id => this.#assets.find(id),
          images: {
            excludeFolders: this.#config.images.describeExclude,
            dailyLimit: this.#config.images.describeDailyLimit,
            describer: this.#describer
          }
        })
        : await runJob(this.#db, this.#wiki, this.#embedder, job, this.#links, this.#requeueDocuments)
      await complete(this.#db, job)
      // A reader's cached "yes" for something that has just left the
      // index would hide it from the check that drops it.
      if (outcome.action === 'removed' || outcome.action === 'hidden') { this.#permissions.clear() }

      const message = job.kind === 'document' ? 'indexed a document' : 'indexed a page'
      // A file left out of the index is the one thing an administrator has
      // to be able to find in the log, so say so plainly.
      if (job.kind === 'document' && outcome.action === 'skipped' && outcome.reason !== 'unchanged') {
        this.#log.info({ ...what, path: job.path, ms: Date.now() - startedAt, ...outcome }, 'document not indexed')
        return
      }
      this.#log.info({ ...what, event: job.event, ms: Date.now() - startedAt, ...outcome }, message)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const { dropped } = await fail(this.#db, job, reason)
      this.#log.warn({ ...what, event: job.event, attempts: job.attempts + 1, dropped, err }, 'indexing failed')
    }
  }
}

/** Wiki.js and Postgres round timestamps differently; compare the instant. */
function sameInstant (a: string, b: string): boolean {
  const left = Date.parse(a)
  const right = Date.parse(b)
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1000
}

function emptyCounts (): Awaited<ReturnType<typeof indexCounts>> {
  return {
    pages: 0,
    pagesWithoutChunks: 0,
    documents: 0,
    skippedDocuments: 0,
    chunks: 0,
    imageDescriptions: 0,
    imageTextRows: 0,
    documentLinks: 0
  }
}

function noDrift (): Omit<IndexReport['drift'], 'note'> {
  return {
    pagesMissingFromIndex: 0,
    pagesOnlyInIndex: 0,
    filesMissingFromIndex: 0,
    filesOnlyInIndex: 0,
    pagesOutsideWindow: 0,
    pagesWithoutChunks: 0
  }
}
