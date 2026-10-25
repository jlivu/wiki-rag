import { createHash } from 'node:crypto'

/**
 * Whether a reader may open a page.
 *
 * The index is built with the admin key, so what it holds is not what any
 * one reader may see. Every candidate is checked against Wiki.js as that
 * reader before it reaches the model — which is a request per page, hence
 * this short-lived cache. A minute is long enough for the follow-up
 * questions in one conversation and short enough that a permission change
 * takes effect while someone is still reading.
 */
const TTL_MS = 60_000
const MAX_ENTRIES = 2000

interface Entry {
  readable: boolean
  expires: number
}

export class PermissionCache {
  readonly #entries = new Map<string, Entry>()

  get (token: string | null, locale: string, path: string): boolean | undefined {
    const key = cacheKey(token, locale, path)
    const entry = this.#entries.get(key)
    if (!entry) { return undefined }
    if (entry.expires < Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.readable
  }

  set (token: string | null, locale: string, path: string, readable: boolean): void {
    if (this.#entries.size >= MAX_ENTRIES) {
      // Cheap eviction: drop the oldest insertion.
      const oldest = this.#entries.keys().next()
      if (!oldest.done) { this.#entries.delete(oldest.value) }
    }
    this.#entries.set(cacheKey(token, locale, path), { readable, expires: Date.now() + TTL_MS })
  }
}

/** The token is hashed so no login token is held as a map key. */
function cacheKey (token: string | null, locale: string, path: string): string {
  const who = token ? createHash('sha256').update(token).digest('hex').slice(0, 32) : 'guest'
  return `${who}\n${locale}\n${path}`
}
