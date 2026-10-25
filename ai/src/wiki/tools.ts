/**
 * The two tools the agent uses to read the wiki. Both run here on the
 * server, as the reader who asked, so Wiki.js decides what they may see.
 */
import type { ToolSpec } from '../providers/types.js'

import { WikiClient, WikiError } from './client.js'
import { htmlToMarkdown, trimForContext } from './markdown.js'

export const SEARCH_WIKI = 'search_wiki'
export const GET_PAGE = 'get_page'

const DEFAULT_RESULT_LIMIT = 8
const MAX_RESULT_LIMIT = 20
const MAX_PAGE_CHARS = 12000

export function wikiToolSpecs (defaultLocale: string): ToolSpec[] {
  return [
    {
      name: SEARCH_WIKI,
      description: [
        'Search this wiki for pages matching a short keyword query, and get back their titles, paths and descriptions.',
        'Call it before answering anything about the wiki\'s content. Two or three keywords work better than a sentence;',
        'search again with different words if the first set finds nothing. It returns only pages the reader is allowed to see,',
        'and it does not return page content — follow up with get_page to read one.'
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to look for, e.g. "restore database backup".' },
          locale: { type: 'string', description: `Locale code to limit the search to. Defaults to "${defaultLocale}".` },
          limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_LIMIT, description: `How many results to return. Defaults to ${DEFAULT_RESULT_LIMIT}.` }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      name: GET_PAGE,
      description: [
        'Read one wiki page as Markdown, by the path search_wiki returned.',
        'Use it for every page you intend to quote, cite or summarise; search results alone are not enough to answer from.',
        'Fails if the reader is not allowed to see the page.'
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Page path without the locale, e.g. "ops/backup-and-restore".' },
          locale: { type: 'string', description: `Locale code. Defaults to "${defaultLocale}".` }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  ]
}

export function isWikiTool (name: string): boolean {
  return name === SEARCH_WIKI || name === GET_PAGE
}

export interface ToolOutcome {
  /** JSON handed back to the model. */
  result: string
  /** For the run log: no page content, just shape. */
  summary: Record<string, unknown>
}

export async function runWikiTool (
  client: WikiClient,
  defaultLocale: string,
  name: string,
  args: unknown
): Promise<ToolOutcome> {
  const input = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  try {
    if (name === SEARCH_WIKI) { return await search(client, defaultLocale, input) }
    if (name === GET_PAGE) { return await getPage(client, defaultLocale, input) }
    return fail(`There is no tool called "${name}".`)
  } catch (err) {
    if (err instanceof WikiError) {
      return fail(`The wiki could not answer: ${err.message}.`)
    }
    throw err
  }
}

interface SearchResponse {
  pages: {
    search: {
      results: Array<{ id: string, title: string, description: string, path: string, locale: string }>
      totalHits: number
      suggestions: string[]
    }
  }
}

const SEARCH_QUERY = `
  query AiSearch($query: String!, $locale: String) {
    pages {
      search(query: $query, locale: $locale) {
        results { id title description path locale }
        suggestions
        totalHits
      }
    }
  }
`

async function search (
  client: WikiClient,
  defaultLocale: string,
  input: Record<string, unknown>
): Promise<ToolOutcome> {
  const query = asString(input.query)
  if (!query) { return fail('search_wiki needs a "query".') }

  const locale = asString(input.locale) ?? defaultLocale
  const limit = Math.min(asInt(input.limit) ?? DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT)

  const data = await client.graphql<SearchResponse>(SEARCH_QUERY, { query, locale })
  const found = data.pages.search
  const results = found.results.slice(0, limit).map(page => ({
    title: page.title,
    path: page.path,
    locale: page.locale,
    description: page.description
  }))

  return {
    result: JSON.stringify({
      query,
      results,
      totalHits: found.totalHits,
      suggestions: found.suggestions.slice(0, 5),
      ...(results.length === 0
        ? { note: 'Nothing matched. Try different keywords, or tell the reader the wiki does not cover this.' }
        : {})
    }),
    summary: { query, locale, results: results.length, totalHits: found.totalHits }
  }
}

async function getPage (
  client: WikiClient,
  defaultLocale: string,
  input: Record<string, unknown>
): Promise<ToolOutcome> {
  const rawPath = asString(input.path)
  if (!rawPath) { return fail('get_page needs a "path".') }

  const locale = asString(input.locale) ?? defaultLocale
  // Tolerate a path that still carries its locale, e.g. "/en/ops/backup".
  const path = rawPath.replace(/^\/+/, '').replace(new RegExp(`^${locale}/`), '')

  const page = await client.fetchPage(path, locale)
  const markdown = trimForContext(htmlToMarkdown(page.html), MAX_PAGE_CHARS)

  return {
    result: JSON.stringify({
      title: page.title,
      path: page.path,
      locale: page.locale,
      updatedAt: page.updatedAt,
      description: page.description,
      content: markdown.text
    }),
    summary: { path: page.path, locale: page.locale, chars: markdown.text.length, truncated: markdown.truncated }
  }
}

function fail (message: string): ToolOutcome {
  return { result: JSON.stringify({ error: message }), summary: { error: message } }
}

function asString (value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asInt (value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}
