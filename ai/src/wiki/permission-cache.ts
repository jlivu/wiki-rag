import { createHash } from 'node:crypto'

/**
 * Whether a reader may open a page.
 *
 * The index is built with the admin key, so what it holds is not what any
 * one reader may see. Every candidate is checked against Wiki.js as that
 * reader before it reaches the model — which is a request per page, hence
 * this short-lived cache.
 *
 * A "no" and a "yes" are not kept for the same length of time, because
 * they are not the same kind of answer. "No" is a permission decision:
 * stable, the common case, and the one worth not asking twice. "Yes" is
 * also the claim that the page is *there*, and that claim is what tells
 * the index it has gone stale — so holding on to it would mean serving a
 * deleted page until the entry expired. A few seconds is long enough for
 * the searches and reads inside one answer, which is where the saving is.
 * Anything that leaves the index clears the cache outright.
 */
const YES_TTL_MS = 15_000
const NO_TTL_MS = 60_000
const MAX_ENTRIES = 2000

interface Entry {
  readable: boolean
  expires: number
}

/** A page and a file can share a path; the kind keeps them apart. */
export type ResourceKind = 'page' | 'document'

export class PermissionCache {
  readonly #entries = new Map<string, Entry>()

  get (token: string | null, kind: ResourceKind, locale: string, path: string): boolean | undefined {
    const key = cacheKey(token, kind, locale, path)
    const entry = this.#entries.get(key)
    if (!entry) { return undefined }
    if (entry.expires < Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.readable
  }

  set (token: string | null, kind: ResourceKind, locale: string, path: string, readable: boolean): void {
    if (this.#entries.size >= MAX_ENTRIES) {
      // Cheap eviction: drop the oldest insertion.
      const oldest = this.#entries.keys().next()
      if (!oldest.done) { this.#entries.delete(oldest.value) }
    }
    const ttl = readable ? YES_TTL_MS : NO_TTL_MS
    this.#entries.set(cacheKey(token, kind, locale, path), { readable, expires: Date.now() + ttl })
  }

  /**
   * Forget every decision.
   *
   * Called whenever something leaves the index: a cached "yes" for a page
   * the wiki no longer has would otherwise keep it out of the one check
   * that would notice. Removals are rare and re-checking is one request
   * per candidate, so there is nothing to be gained by being cleverer.
   */
  clear (): void {
    this.#entries.clear()
  }
}

/** The token is hashed so no login token is held as a map key. */
function cacheKey (token: string | null, kind: ResourceKind, locale: string, path: string): string {
  const who = token ? createHash('sha256').update(token).digest('hex').slice(0, 32) : 'guest'
  return `${who}\n${kind}\n${locale}\n${path}`
}
