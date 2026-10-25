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
import { ANCHOR_MIGRATION, ensureEmbeddingColumn, migrate, readMeta } from '../index-db/migrate.js'
import { getPool } from '../index-db/pool.js'
import {
  claim, complete, enqueue, enqueueIfAbsent, fail, queueDepth,
  type IndexEvent, type QueuedJob
} from '../index-db/queue.js'
import {
  listIndexedDocuments, listIndexedPages, readStats, removeDocument, removePage, type IndexStats
} from '../index-db/store.js'
import { WikiAdminClient } from '../wiki/admin-client.js'

import { PermissionCache } from '../wiki/permission-cache.js'

import { createImageDescriber, type ImageDescriber } from '../images/describe.js'

import { AssetDirectory } from './asset-directory.js'
import { runDocumentJob } from './document-job.js'
import { Embedder } from './embeddings.js'
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

export class Indexer {
  readonly #config: Config
  readonly #log: FastifyBaseLogger
  readonly #db: Pool
  readonly #wiki: WikiAdminClient
  readonly #embedder: Embedder
  readonly #retriever: Retriever
  readonly #assets: AssetDirectory
  readonly #describer: ImageDescriber

  #ready = false
  #reason: string | undefined
  #stopped = false
  #workerTimer: NodeJS.Timeout | null = null
  #reconcileTimer: NodeJS.Timeout | null = null
  #startupTimer: NodeJS.Timeout | null = null
  #draining = false

  constructor (config: Config, log: FastifyBaseLogger) {
    this.#config = config
    this.#log = log.child({ module: 'indexer' })
    this.#db = getPool(config.index.databaseUrl)
    this.#wiki = new WikiAdminClient(config.wikiUrl, config.index.wikiApiKey)
    this.#embedder = new Embedder(config.llm.ollamaUrl, config.index.embedModel)
    this.#assets = new AssetDirectory(this.#wiki)
    this.#describer = createImageDescriber(config)
    this.#retriever = new Retriever(this.#db, this.#embedder, new PermissionCache(), this.#log)
  }

  /** Where an asset link in a page points, and what is not a file. */
  get #links (): LinkScanOptions {
    return {
      origins: [this.#config.wikiUrl, this.#config.wikiPublicUrl].filter(url => url.length > 0),
      pageExtensions: this.#config.index.pageExtensions
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
    try {
      const ran = await migrate(this.#db)
      if (ran.length > 0) { this.#log.info({ migrations: ran }, 'index schema migrated') }
      // Existing chunks predate section anchors, so they have to be built
      // again. The text is unchanged, so no embedding is recomputed.
      rebuildChunks = ran.includes(ANCHOR_MIGRATION)
    } catch (err) {
      this.#reason = 'the index database is unreachable'
      this.#log.error({ err }, 'the index database could not be prepared')
      return
    }

    await this.#prepareEmbeddings()

    this.#workerTimer = setTimeout(() => { void this.#drain() }, IDLE_POLL_MS)
    this.#startupTimer = setTimeout(() => {
      void (rebuildChunks ? this.reindexEverything() : this.reconcile('startup'))
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

      let removed = 0
      for (const id of have.keys()) {
        if (!live.has(id)) {
          await removePage(this.#db, id)
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
      for (const id of haveFiles.keys()) {
        if (!liveFiles.has(id)) {
          await removeDocument(this.#db, id)
          removedFiles += 1
        }
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
        removedFiles
      }, 'reconciled')
      return { queued: queued + queuedFiles, removed: removed + removedFiles }
    } catch (err) {
      this.#log.warn({ err, trigger }, 'reconciliation failed')
      return null
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
        : await runJob(this.#db, this.#wiki, this.#embedder, job, this.#links, async ids => {
          // A changed caption makes the image stale, not the page.
          for (const id of ids) {
            await enqueueIfAbsent(this.#db, { kind: 'document', entityId: id, event: 'updated' })
          }
        })
      await complete(this.#db, job)

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
