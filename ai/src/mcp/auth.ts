/**
 * Every MCP request carries a Wiki.js API key as a bearer token, and every
 * read runs with that key's own permissions. This module only answers
 * "is this key real?"; what it may see is Wiki.js's business, enforced the
 * same way it is for a signed-in reader.
 *
 * Keys are never logged. A short fingerprint stands in for one.
 */
import { createHash } from 'node:crypto'

/** Long enough to spare the wiki a round trip per tool call, short enough
 *  that revoking a key takes effect while an agent is still working. */
const TTL_MS = 60_000
const MAX_ENTRIES = 500

interface Entry {
  valid: boolean
  isApiKey: boolean
  expires: number
}

export interface KeyCheck {
  valid: boolean
  /** True for a Wiki.js API key, false for a signed-in user's own token. */
  isApiKey: boolean
  fingerprint: string
}

/**
 * `users.profile` is the probe: Wiki.js refuses it for the guest account
 * (id 2) and for anything unauthenticated, and answers it for an API key
 * (which it resolves to id 1 with the key's group permissions, see
 * server/core/auth.js). So a successful call means the caller is somebody.
 */
const PROBE = '{ users { profile { id email } } }'

export class McpAuth {
  readonly #wikiUrl: string
  readonly #timeoutMs: number
  readonly #cache = new Map<string, Entry>()

  constructor (wikiUrl: string, timeoutMs = 10000) {
    this.#wikiUrl = wikiUrl
    this.#timeoutMs = timeoutMs
  }

  async check (token: string): Promise<KeyCheck> {
    const fingerprint = fingerprintOf(token)
    const cached = this.#cache.get(fingerprint)
    if (cached && cached.expires > Date.now()) {
      return { valid: cached.valid, isApiKey: cached.isApiKey, fingerprint }
    }

    let valid = false
    let isApiKey = false
    try {
      const response = await fetch(`${this.#wikiUrl}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: PROBE }),
        signal: AbortSignal.timeout(this.#timeoutMs)
      })
      if (response.ok) {
        const body = await response.json() as {
          data?: { users?: { profile?: { id?: number, email?: string } } }
          errors?: Array<{ message: string }>
        }
        const profile = body.data?.users?.profile
        valid = !body.errors?.length && typeof profile?.id === 'number'
        isApiKey = profile?.email === 'api@localhost'
      }
    } catch {
      // An unreachable wiki is not a valid key; the caller answers 401 and
      // the result is not cached.
      return { valid: false, isApiKey: false, fingerprint }
    }

    if (this.#cache.size >= MAX_ENTRIES) {
      const oldest = this.#cache.keys().next()
      if (!oldest.done) { this.#cache.delete(oldest.value) }
    }
    this.#cache.set(fingerprint, { valid, isApiKey, expires: Date.now() + TTL_MS })
    return { valid, isApiKey, fingerprint }
  }
}

/** Enough to tell two keys apart in a log, useless for anything else. */
export function fingerprintOf (token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 10)
}

/** The bearer token, or null. */
export function readBearer (header: string | undefined): string | null {
  if (typeof header !== 'string' || !/^bearer\s+/i.test(header)) { return null }
  const token = header.replace(/^bearer\s+/i, '').trim()
  return token.length > 0 ? token : null
}
