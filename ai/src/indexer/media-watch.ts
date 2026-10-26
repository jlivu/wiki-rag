/**
 * Keeping the index in step with the media folder.
 *
 * The folder is both watched and swept. Watching is the quick path: a
 * file dropped in is noticed within a couple of seconds. The sweep is the
 * one that can be relied on — an event missed while the service was down,
 * or a file copied straight into the folder by another machine, is found
 * the next time round — and it is the same arrangement pages have, where
 * the wiki's events are the quick path and reconciliation is the truth.
 *
 * A file is left alone until it has stopped changing. A video copied in
 * over a minute would otherwise be read while it was still half there,
 * and indexed as a broken file.
 */
import { watch, type FSWatcher } from 'node:fs'

import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'

import { enqueueIfAbsent } from '../index-db/queue.js'
import { claimVideoId, listIndexedVideos, removeVideo } from '../index-db/store.js'
import { sourceHashOf, titleFrom, type MediaLibrary } from '../media/library.js'

/** Several files arriving together become one sweep. */
const DEBOUNCE_MS = 2000

export interface MediaSweep {
  queued: number
  removed: number
  /** Files still being written, which the next sweep will pick up. */
  settling: number
  total: number
}

export class MediaWatcher {
  readonly #library: MediaLibrary
  readonly #db: Pool
  readonly #log: FastifyBaseLogger
  readonly #settleMs: number
  readonly #everyMs: number

  #watcher: FSWatcher | null = null
  #timer: NodeJS.Timeout | null = null
  #debounce: NodeJS.Timeout | null = null
  #sweeping = false
  #stopped = false

  readonly #onSweep: ((sweep: MediaSweep) => void) | undefined

  constructor (
    library: MediaLibrary,
    db: Pool,
    log: FastifyBaseLogger,
    options: {
      settleSeconds: number
      scanSeconds: number
      /** Every sweep, so the status can report what is in the folder. */
      onSweep?: (sweep: MediaSweep) => void
    }
  ) {
    this.#library = library
    this.#db = db
    this.#log = log
    this.#settleMs = Math.max(0, options.settleSeconds) * 1000
    this.#everyMs = Math.max(5, options.scanSeconds) * 1000
    this.#onSweep = options.onSweep
  }

  async start (): Promise<void> {
    if (this.#stopped) { return }

    // Docker Desktop does forward file events from the Mac into the
    // container, so this works — but it is the sweep below that the
    // index actually depends on.
    try {
      this.#watcher = watch(this.#library.root, { recursive: true }, () => { this.#soon() })
      this.#watcher.on('error', err => {
        this.#log.warn({ err }, 'the media folder could not be watched; sweeping only')
        this.#watcher?.close()
        this.#watcher = null
      })
    } catch (err) {
      this.#log.warn({ err }, 'the media folder could not be watched; sweeping only')
    }

    this.#timer = setInterval(() => { void this.sweep('scheduled') }, this.#everyMs)
  }

  stop (): void {
    this.#stopped = true
    this.#watcher?.close()
    this.#watcher = null
    if (this.#timer) { clearInterval(this.#timer) }
    if (this.#debounce) { clearTimeout(this.#debounce) }
  }

  /** Compare the folder with the index and queue the difference. */
  async sweep (trigger: string): Promise<MediaSweep> {
    const empty: MediaSweep = { queued: 0, removed: 0, settling: 0, total: 0 }
    if (this.#stopped || this.#sweeping) { return empty }
    this.#sweeping = true
    try {
      const files = await this.#library.list()
      const indexed = await listIndexedVideos(this.#db)
      const byPath = new Map(indexed.map(video => [video.path, video]))
      const now = Date.now()

      let queued = 0
      let settling = 0
      for (const file of files) {
        // Still being copied in: leave it for the next sweep.
        if (this.#settleMs > 0 && now - Date.parse(file.modifiedAt) < this.#settleMs) {
          settling += 1
          continue
        }
        const already = byPath.get(file.path)
        if (already && already.sourceHash === sourceHashOf(file)) { continue }

        const id = already?.id ?? await claimVideoId(this.#db, {
          path: file.path,
          fileName: file.fileName,
          ext: file.ext,
          title: titleFrom(file.fileName),
          fileSize: file.fileSize,
          modifiedAt: file.modifiedAt
        })
        await enqueueIfAbsent(this.#db, { kind: 'video', entityId: id, event: 'updated', path: file.path })
        queued += 1
      }

      const present = new Set(files.map(file => file.path))
      let removed = 0
      for (const video of indexed) {
        if (present.has(video.path)) { continue }
        await removeVideo(this.#db, video.id)
        removed += 1
      }

      if (queued > 0 || removed > 0) {
        this.#log.info({ trigger, videos: files.length, queued, removed, settling }, 'swept the media folder')
      }
      const sweep = { queued, removed, settling, total: files.length }
      this.#onSweep?.(sweep)
      return sweep
    } catch (err) {
      this.#log.warn({ err, trigger }, 'the media folder could not be swept')
      return empty
    } finally {
      this.#sweeping = false
    }
  }

  #soon (): void {
    if (this.#debounce) { clearTimeout(this.#debounce) }
    this.#debounce = setTimeout(() => { void this.sweep('watch') }, DEBOUNCE_MS)
  }
}
