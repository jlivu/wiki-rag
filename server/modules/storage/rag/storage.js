const _ = require('lodash')

/* global WIKI */

/**
 * AI ASSISTANT INDEX
 *
 * Tells the AI service which page changed, so it can keep its search index
 * current. It stores nothing itself.
 *
 * Saving a page must never fail or slow down because of the assistant, so
 * every notification is sent without waiting for the reply, bounded by a
 * short timeout, and every error is logged rather than thrown.
 */
module.exports = {
  async activated() { },

  async deactivated() { },

  async init() {
    WIKI.logger.info(`(STORAGE/RAG) Notifying the AI service at ${this.config.indexerUrl}`)
  },

  /**
   * Scheduled sync: ask the AI service to compare its index with the wiki.
   */
  async sync() {
    await this.notify('/internal/reconcile', {}, { wait: true })
  },

  async created(page) {
    this.notifyPageEvent('created', page)
  },

  async updated(page) {
    this.notifyPageEvent('updated', page)
  },

  async deleted(page) {
    this.notifyPageEvent('deleted', page)
  },

  async renamed(page) {
    // The hook runs before the move, so send where the page is going.
    this.notifyPageEvent('renamed', page, {
      path: page.destinationPath,
      locale: page.destinationLocaleCode
    })
  },

  // Assets are not indexed, but these have to exist: WIKI.models.storage
  // calls them on every upload and rethrows anything that goes wrong.
  async assetUploaded() { },
  async assetDeleted() { },
  async assetRenamed() { },

  async getLocalLocation() {
    return null
  },

  /**
   * ADMIN ACTION: throw the index away and build it again.
   */
  async reindexAll() {
    WIKI.logger.info('(STORAGE/RAG) Asking the AI service to re-index everything...')
    await this.notify('/internal/reindex', {}, { wait: true })
    WIKI.logger.info('(STORAGE/RAG) Re-index requested.')
  },

  /**
   * ADMIN ACTION: reconcile without waiting for the schedule.
   */
  async syncNow() {
    WIKI.logger.info('(STORAGE/RAG) Asking the AI service to reconcile...')
    await this.notify('/internal/reconcile', {}, { wait: true })
    WIKI.logger.info('(STORAGE/RAG) Reconcile requested.')
  },

  /**
   * Fire a page event and return at once. Nothing here is awaited by the
   * page save.
   */
  notifyPageEvent(event, page, override = {}) {
    const body = {
      event,
      id: _.get(page, 'id', null),
      path: _.get(override, 'path', _.get(page, 'path', null)),
      locale: _.get(override, 'locale', _.get(page, 'localeCode', null))
    }
    if (!body.id) {
      WIKI.logger.warn(`(STORAGE/RAG) Skipping ${event}: the page has no id.`)
      return
    }
    // Deliberately not awaited.
    this.notify('/internal/page-event', body, { wait: false })
  },

  /**
   * POST to the AI service. Errors are logged, never thrown.
   */
  async notify(path, body, { wait }) {
    const base = _.trimEnd(_.get(this, 'config.indexerUrl', 'http://ai:4000'), '/')
    const timeoutMs = _.toInteger(_.get(this, 'config.timeoutMs', 2000)) || 2000

    const send = async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const resp = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        })
        if (!resp.ok) {
          WIKI.logger.warn(`(STORAGE/RAG) ${path} returned ${resp.status}.`)
        }
      } catch (err) {
        WIKI.logger.warn(`(STORAGE/RAG) ${path} failed: ${err.message}`)
      } finally {
        clearTimeout(timer)
      }
    }

    if (wait) {
      await send()
    } else {
      send().catch(err => {
        WIKI.logger.warn(`(STORAGE/RAG) ${path} failed: ${err.message}`)
      })
    }
  }
}
