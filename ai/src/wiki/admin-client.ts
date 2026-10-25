/**
 * Wiki.js GraphQL as the wiki itself, with WIKI_API_KEY.
 *
 * This is the one place an administrator token is used, and only the indexer
 * uses it: building the index needs every page's source, which no reader can
 * fetch. Questions are still answered with the asking reader's own token —
 * see wiki/client.ts.
 *
 * The key is read from the environment and never logged.
 */
import { WikiError } from './client.js'

export interface WikiPageSummary {
  id: number
  path: string
  locale: string
  title: string
  description: string
  contentType: string
  isPublished: boolean
  updatedAt: string
}

export interface WikiPageSource extends WikiPageSummary {
  /** The page as it was written. */
  content: string
  /** The rendered HTML, used when the source is not Markdown. */
  render: string
}

const LIST_QUERY = `
  query AiIndexList {
    pages {
      list(orderBy: ID) {
        id path locale title description contentType isPublished updatedAt
      }
    }
  }
`

const SINGLE_QUERY = `
  query AiIndexPage($id: Int!) {
    pages {
      single(id: $id) {
        id path locale title description contentType isPublished updatedAt content render
      }
    }
  }
`

export class WikiAdminClient {
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #timeoutMs: number

  constructor (baseUrl: string, apiKey: string, timeoutMs = 20000) {
    this.#baseUrl = baseUrl
    this.#apiKey = apiKey
    this.#timeoutMs = timeoutMs
  }

  async listPages (): Promise<WikiPageSummary[]> {
    const data = await this.#graphql<{ pages: { list: WikiPageSummary[] } }>(LIST_QUERY, {})
    return data.pages.list
  }

  /** Null when the page is gone, so the indexer can drop it. */
  async fetchPage (id: number): Promise<WikiPageSource | null> {
    try {
      const data = await this.#graphql<{ pages: { single: WikiPageSource | null } }>(SINGLE_QUERY, { id })
      return data.pages.single
    } catch (err) {
      // Wiki.js answers PageNotFound with "This page does not exist."
      // (server/helpers/error.js); a missing page is an answer, not a fault.
      if (err instanceof WikiError && (err.status === 404 || /does not exist|not found/i.test(err.message))) {
        return null
      }
      throw err
    }
  }

  async #graphql<T> (query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.#timeoutMs)
      })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable'
      throw new WikiError(503, `the wiki ${reason}`)
    }

    if (!response.ok) {
      throw new WikiError(response.status, `the wiki returned ${response.status}`)
    }

    const body = await response.json() as { data?: T, errors?: Array<{ message: string }> }
    if (body.errors && body.errors.length > 0) {
      const first = body.errors[0]?.message ?? 'unknown error'
      // A rejected key looks the same as a forbidden field; say which.
      const status = /forbidden|unauthorized|invalid token|jwt/i.test(first) ? 403 : 400
      throw new WikiError(status, first)
    }
    if (!body.data) {
      throw new WikiError(500, 'the wiki returned no data')
    }
    return body.data
  }
}
