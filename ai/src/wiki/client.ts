/**
 * Talks to Wiki.js as the reader who asked the question.
 *
 * The panel is served from the same origin as the wiki, so the browser sends
 * the reader's `jwt` cookie with every run. That token is forwarded here, and
 * Wiki.js applies its own page permissions to it. With no token the reader is
 * the guest account, exactly as if they were logged out in a browser.
 *
 * There is deliberately no admin key anywhere in this file.
 */
import type { FastifyRequest } from 'fastify'

export class WikiError extends Error {
  readonly status: number
  constructor (status: number, message: string) {
    super(message)
    this.name = 'WikiError'
    this.status = status
  }
}

export interface WikiPageHtml {
  title: string
  description: string
  path: string
  locale: string
  updatedAt: string
  html: string
}

/** Whether a reader may open a file — and, if not, whether it is there. */
export type AssetAccess = 'yes' | 'no' | 'missing'

export class WikiClient {
  readonly #baseUrl: string
  readonly #token: string | null
  readonly #timeoutMs: number

  constructor (baseUrl: string, token: string | null, timeoutMs = 15000) {
    this.#baseUrl = baseUrl
    this.#token = token
    this.#timeoutMs = timeoutMs
  }

  /** True when the question came from a signed-in reader. */
  get isAuthenticated (): boolean {
    return this.#token !== null
  }

  async graphql<T> (query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.#fetch('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables })
    })

    if (!response.ok) {
      throw new WikiError(response.status, `the wiki returned ${response.status}`)
    }

    const body = await response.json() as { data?: T, errors?: Array<{ message: string }> }
    if (body.errors && body.errors.length > 0) {
      const first = body.errors[0]?.message ?? 'unknown error'
      // Wiki.js answers "Forbidden" when the reader may not see something.
      throw new WikiError(/forbidden|unauthorized/i.test(first) ? 403 : 400, first)
    }
    if (!body.data) {
      throw new WikiError(500, 'the wiki returned no data')
    }
    return body.data
  }

  /**
   * The rendered page, as the reader would see it. Wiki.js renders a page
   * only to someone allowed to read it, so this is the permission check.
   *
   * Reading the rendered HTML rather than the Markdown source is deliberate:
   * `pages.single` and `pages.singleByPath` both require an editor
   * permission, and `Page.content` needs `read:source`, so neither is
   * available to an ordinary reader.
   */
  async fetchPage (path: string, locale: string): Promise<WikiPageHtml> {
    const clean = path.replace(/^\/+|\/+$/g, '')
    const response = await this.#fetch(`/${encodeURI(locale)}/${encodeURI(clean)}`, {
      method: 'GET',
      headers: { accept: 'text/html' },
      redirect: 'manual'
    })

    if (response.status >= 300 && response.status < 400) {
      // Wiki.js sends a reader who may not see the page to the login form.
      throw new WikiError(403, 'that page is not readable with your account')
    }
    if (!response.ok) {
      throw new WikiError(response.status, response.status === 404 ? 'no such page' : `the wiki returned ${response.status}`)
    }

    const body = await response.text()
    const contents = extractContents(body)
    if (contents === null) {
      throw new WikiError(403, 'that page is not readable with your account')
    }

    const attrs = extractPageAttributes(body)
    return {
      title: attrs.title ?? clean,
      description: attrs.description ?? '',
      path: attrs.path ?? clean,
      locale: attrs.locale ?? locale,
      updatedAt: attrs['updated-at'] ?? '',
      html: contents
    }
  }

  /**
   * Whether this reader may open an uploaded file.
   *
   * Wiki.js serves assets from the catch-all route, which checks
   * `read:assets` against the file's path and answers 403 when it refuses
   * (server/controllers/common.js). A HEAD costs nothing once the file is
   * in the wiki's cache, which the indexer's own download has already
   * warmed. Anything other than a plain 200 is treated as "no".
   */
  async canReadAsset (path: string): Promise<AssetAccess> {
    const clean = path.replace(/^\/+/, '')
    try {
      const response = await this.#fetch(`/${encodeURI(clean)}`, {
        method: 'HEAD',
        redirect: 'manual'
      })
      // Wiki.js answers 403 when read:assets says no and 404 when the file
      // is not there — and it clears a deleted file's cache, so a 404 here
      // really does mean gone. The index needs to tell the two apart: one
      // is this reader's business, the other is the index being stale.
      if (response.status === 404) { return 'missing' }
      if (response.status !== 200) { return 'no' }
      // A page extension lands in the page branch, which answers with HTML
      // whether or not the reader may see anything.
      return (response.headers.get('content-type') ?? '').startsWith('text/html') ? 'no' : 'yes'
    } catch {
      return 'no'
    }
  }

  /**
   * Whether the token belongs to a real, signed-in reader.
   *
   * Videos are not Wiki.js assets, so there is no `read:assets` to apply
   * to them: the rule is that the media folder is open to anyone with a
   * wiki login and to nobody else. `users.profile` is the probe, because
   * Wiki.js refuses it for the guest account and answers it for a signed-
   * in user — the same question the MCP server asks of an API key.
   */
  async isSignedIn (): Promise<boolean> {
    if (this.#token === null) { return false }
    try {
      const data = await this.graphql<{ users?: { profile?: { id?: number } } }>(
        '{ users { profile { id } } }', {}
      )
      return typeof data.users?.profile?.id === 'number'
    } catch {
      return false
    }
  }

  async #fetch (path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.#token) {
      // Wiki.js accepts the same token as a bearer header or a cookie.
      headers.set('authorization', `Bearer ${this.#token}`)
    }
    const signal = AbortSignal.timeout(this.#timeoutMs)
    try {
      return await fetch(`${this.#baseUrl}${path}`, { ...init, headers, signal })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable'
      throw new WikiError(503, `the wiki ${reason}`)
    }
  }
}

/**
 * The reader's login token, from the request the panel made. The panel is on
 * the wiki's own origin, so the cookie comes along by itself; the header is
 * there for other callers.
 */
export function readWikiToken (request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (typeof header === 'string' && /^bearer\s+/i.test(header)) {
    const token = header.replace(/^bearer\s+/i, '').trim()
    if (token.length > 0) { return token }
  }
  return readCookie(request.headers.cookie, 'jwt')
}

function readCookie (header: string | undefined, name: string): string | null {
  if (!header) { return null }
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) { continue }
    if (part.slice(0, index).trim() !== name) { continue }
    const raw = part.slice(index + 1).trim().replace(/^"|"$/g, '')
    try {
      return decodeURIComponent(raw) || null
    } catch {
      return raw || null
    }
  }
  return null
}

/** The page body sits in `<template slot="contents">` (server/views/page.pug). */
function extractContents (html: string): string | null {
  const open = '<template slot="contents">'
  const start = html.indexOf(open)
  if (start < 0) { return null }

  let depth = 1
  let cursor = start + open.length
  const body = cursor
  while (depth > 0) {
    const nextOpen = html.indexOf('<template', cursor)
    const nextClose = html.indexOf('</template>', cursor)
    if (nextClose < 0) { return null }
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1
      cursor = nextOpen + '<template'.length
    } else {
      depth -= 1
      if (depth === 0) { return html.slice(body, nextClose) }
      cursor = nextClose + '</template>'.length
    }
  }
  return null
}

/** The `<page …>` element carries the title, path and dates as attributes. */
function extractPageAttributes (html: string): Record<string, string> {
  const tag = /<page\b([^>]*)>/.exec(html)
  if (!tag?.[1]) { return {} }
  const attrs: Record<string, string> = {}
  const pattern = /([a-zA-Z:-]+)="([^"]*)"/g
  let match = pattern.exec(tag[1])
  while (match !== null) {
    if (match[1] && match[2] !== undefined) {
      attrs[match[1]] = decodeHtml(match[2])
    }
    match = pattern.exec(tag[1])
  }
  return attrs
}

function decodeHtml (value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}
