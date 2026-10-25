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

/** One uploaded file, with the path Wiki.js serves it at. */
export interface WikiAsset {
  id: number
  /** Folder slugs and the file name: "sops/manual.pdf". No locale. */
  path: string
  fileName: string
  /** Lower case, with the dot. */
  ext: string
  /** Wiki.js's own split: "image" or "binary". */
  kind: string
  mime: string
  fileSize: number
  updatedAt: string
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

/**
 * Both halves of one folder in a single request. `folder` and `author` are
 * never selected: the resolver does no eager loading, so they are always
 * null.
 */
const ASSETS_QUERY = `
  query AiIndexAssets($folderId: Int!) {
    assets {
      list(folderId: $folderId, kind: ALL) {
        id filename ext kind mime fileSize updatedAt
      }
      folders(parentFolderId: $folderId) {
        id slug
      }
    }
  }
`

interface AssetItem {
  id: number
  filename: string
  ext: string | null
  kind: string | null
  mime: string | null
  fileSize: number | null
  updatedAt: string
}

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

  /**
   * Every uploaded file, by walking the folder tree.
   *
   * Wiki.js has no query that returns all assets: `assets.list` takes one
   * folder, `assets.folders` takes one parent, and folder 0 is the root.
   * `AssetItem.folder` always resolves to null, so the path is built from
   * the walk itself. `metadata` is never selected: it is declared String
   * and resolved as an object, the same trap as `Page.toc`.
   */
  async listAssets (): Promise<WikiAsset[]> {
    const found: WikiAsset[] = []
    const queue: Array<{ id: number, path: string }> = [{ id: 0, path: '' }]

    while (queue.length > 0) {
      const folder = queue.shift() as { id: number, path: string }
      const data = await this.#graphql<{
        assets: {
          list: Array<AssetItem | null> | null
          folders: Array<{ id: number, slug: string } | null> | null
        }
      }>(ASSETS_QUERY, { folderId: folder.id })

      for (const item of data.assets.list ?? []) {
        // A row with no fileSize comes back null, because Wiki.js declares
        // that column non-null when it is not.
        if (!item) { continue }
        found.push({
          id: item.id,
          path: folder.path ? `${folder.path}/${item.filename}` : item.filename,
          fileName: item.filename,
          ext: (item.ext ?? '').toLowerCase(),
          kind: (item.kind ?? '').toLowerCase(),
          mime: item.mime ?? '',
          fileSize: item.fileSize ?? 0,
          updatedAt: item.updatedAt
        })
      }

      for (const child of data.assets.folders ?? []) {
        if (!child) { continue }
        queue.push({ id: child.id, path: folder.path ? `${folder.path}/${child.slug}` : child.slug })
      }
    }

    return found
  }

  /**
   * The file itself, as the wiki serves it.
   *
   * Assets sit at the site root with no locale segment, and the only route
   * that serves them is the catch-all page route, so this is a plain GET
   * with the indexer's key.
   */
  async downloadAsset (path: string): Promise<Buffer> {
    const clean = path.replace(/^\/+/, '')
    let response: Response
    try {
      response = await fetch(`${this.#baseUrl}/${encodeURI(clean)}`, {
        headers: { authorization: `Bearer ${this.#apiKey}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs * 3)
      })
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable'
      throw new WikiError(503, `the wiki ${reason}`)
    }

    if (!response.ok) {
      throw new WikiError(response.status, `the file could not be downloaded (${response.status})`)
    }
    const type = response.headers.get('content-type') ?? ''
    if (type.startsWith('text/html')) {
      // The catch-all route answered as a page, not as a file.
      throw new WikiError(404, 'the wiki served a page, not a file, at that path')
    }
    return Buffer.from(await response.arrayBuffer())
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
