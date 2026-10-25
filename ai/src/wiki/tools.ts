/**
 * The tools the agent uses to read the wiki. All of them run here on the
 * server, as the reader who asked, so Wiki.js decides what they may see.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { Pool } from 'pg'

import type { SourceRegistry } from '../agent/sources.js'
import { documentChunks, findDocumentByPath } from '../index-db/search.js'
import type { Retriever } from '../indexer/retrieval.js'
import type { ToolSpec } from '../providers/types.js'

import { WikiClient, WikiError } from './client.js'
import { htmlToMarkdown, trimForContext } from './markdown.js'

export const SEARCH_WIKI = 'search_wiki'
export const GET_PAGE = 'get_page'
export const GET_DOCUMENT = 'get_document'

const DEFAULT_RESULT_LIMIT = 8
const MAX_RESULT_LIMIT = 20
const MAX_PAGE_CHARS = 12000

export function wikiToolSpecs (defaultLocale: string): ToolSpec[] {
  return [
    {
      name: SEARCH_WIKI,
      description: [
        'Search this wiki and get back the pages that match, each with a short snippet of the part that matched.',
        'Call it before answering anything about the wiki\'s content. It searches the words on the page as well as its',
        'title, so a plain question works as well as keywords; search again with different wording if the first attempt',
        'finds nothing. It returns only pages the reader is allowed to see. Each result carries an "id" such as S1:',
        'that is what you cite. The snippets are an extract, not the page — read a page with get_page before you answer',
        'from it.',
        'Results also include uploaded files — PDFs, Word documents, spreadsheets, presentations. A file has',
        '"kind": "document" and a "location" saying where in it the match is ("Page 4", \'Sheet "Budget" rows 12-40\');',
        'read one with get_document, not get_page.'
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
        'The result carries an "id" such as S1, which is what you cite. Fails if the reader is not allowed to see the page.'
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
    },
    {
      name: GET_DOCUMENT,
      description: [
        'Read the text of one uploaded file — a PDF, Word document, spreadsheet or presentation — by the path',
        'search_wiki returned for a result whose "kind" is "document". The text comes back in order, each part',
        'labelled with where it is in the file ("Page 4", "Section \"Pricing\"", "Slide 7"), so you can say where a',
        'fact came from. The result carries an "id" such as S1, which is what you cite. Fails if the reader is not',
        'allowed to open the file.'
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path as search_wiki returned it, e.g. "sops/generator-manual.pdf".' }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  ]
}

export function isWikiTool (name: string): boolean {
  return name === SEARCH_WIKI || name === GET_PAGE || name === GET_DOCUMENT
}

export interface ToolOutcome {
  /** JSON handed back to the model. */
  result: string
  /** For the run log: no page content, just shape. */
  summary: Record<string, unknown>
}

/** Everything a tool needs to answer as the reader who asked. */
export interface ToolContext {
  client: WikiClient
  /** The reader's Wiki.js token, or null for a guest. */
  token: string | null
  defaultLocale: string
  /** Null when there is no index to search. */
  retriever: Retriever | null
  /** The index itself, for reading a document's extracted text. */
  index: Pool | null
  /** Collects what the tools returned, so citations resolve on the server. */
  sources: SourceRegistry
  log: FastifyBaseLogger
}

export async function runWikiTool (
  ctx: ToolContext,
  name: string,
  args: unknown
): Promise<ToolOutcome> {
  const input = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  try {
    if (name === SEARCH_WIKI) { return await search(ctx, input) }
    if (name === GET_PAGE) { return await getPage(ctx, input) }
    if (name === GET_DOCUMENT) { return await getDocument(ctx, input) }
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

/**
 * The index answers when it can. Wiki.js's own search is the fallback, used
 * only when there is no index to ask — not when the index simply found
 * nothing, which is an answer.
 */
async function search (ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const query = asString(input.query)
  if (!query) { return fail('search_wiki needs a "query".') }

  const locale = asString(input.locale) ?? ctx.defaultLocale
  const limit = Math.min(asInt(input.limit) ?? DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT)

  if (ctx.retriever) {
    try {
      if (await ctx.retriever.hasContent()) {
        const found = await ctx.retriever.search(query, locale, limit, ctx.client, ctx.token)
        const results = found.results.map(item => {
          if (item.kind === 'document') {
            const source = ctx.sources.register({
              kind: 'document',
              title: item.fileName,
              path: item.path,
              anchor: item.anchor,
              section: item.location,
              location: item.location,
              fileName: item.fileName,
              fileType: item.docType,
              snippet: item.snippet,
              updatedAt: item.updatedAt,
              linkedFrom: item.linkedFrom
            })
            return {
              id: source.id,
              kind: 'document',
              fileName: item.fileName,
              fileType: item.docType,
              path: item.path,
              location: item.location,
              url: source.url,
              snippet: item.snippet,
              updatedAt: item.updatedAt,
              ...(item.linkedFrom.length > 0
                ? { linkedFrom: item.linkedFrom.map(page => page.title || page.path) }
                : {}),
              score: item.score
            }
          }

          const source = ctx.sources.register({
            title: item.title,
            path: item.path,
            locale: item.locale,
            anchor: item.anchor,
            section: item.heading,
            snippet: item.snippet,
            updatedAt: item.updatedAt
          })
          return {
            id: source.id,
            kind: 'page',
            title: item.title,
            path: item.path,
            section: item.heading,
            url: source.url,
            snippet: item.snippet,
            updatedAt: item.updatedAt,
            score: item.score
          }
        })
        return {
          result: JSON.stringify({
            query,
            results,
            ...(results.length === 0
              ? { note: 'Nothing matched. Try different wording, or tell the reader the wiki does not cover this.' }
              : {})
          }),
          summary: {
            query,
            locale,
            source: 'index',
            results: found.results.length,
            checked: found.checked,
            filtered: found.filtered
          }
        }
      }
      ctx.log.warn({ query }, 'the page index is empty; falling back to the wiki search')
    } catch (err) {
      ctx.log.warn({ err, query }, 'the page index could not be searched; falling back to the wiki search')
    }
  }

  return await searchViaWiki(ctx, query, locale, limit)
}

/** Wiki.js's own search engine, which filters by reader on its side. */
async function searchViaWiki (
  ctx: ToolContext,
  query: string,
  locale: string,
  limit: number
): Promise<ToolOutcome> {
  const data = await ctx.client.graphql<SearchResponse>(SEARCH_QUERY, { query, locale })
  const found = data.pages.search
  const results = found.results.slice(0, limit).map(page => {
    const source = ctx.sources.register({
      title: page.title,
      path: page.path,
      locale: page.locale,
      snippet: page.description
    })
    return {
      id: source.id,
      title: page.title,
      path: page.path,
      url: source.url,
      description: page.description
    }
  })

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
    summary: { query, locale, source: 'wiki', results: results.length, totalHits: found.totalHits }
  }
}

async function getPage (ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const client = ctx.client
  const rawPath = asString(input.path)
  if (!rawPath) { return fail('get_page needs a "path".') }

  const locale = asString(input.locale) ?? ctx.defaultLocale
  // Tolerate a path that still carries its locale, e.g. "/en/ops/backup".
  const path = rawPath.replace(/^\/+/, '').replace(new RegExp(`^${locale}/`), '')

  const page = await client.fetchPage(path, locale)
  const markdown = trimForContext(htmlToMarkdown(page.html), MAX_PAGE_CHARS)
  const source = ctx.sources.register({
    title: page.title,
    path: page.path,
    locale: page.locale,
    updatedAt: page.updatedAt,
    snippet: page.description,
    read: true
  })

  return {
    result: JSON.stringify({
      id: source.id,
      title: page.title,
      path: page.path,
      locale: page.locale,
      url: source.url,
      updatedAt: page.updatedAt,
      description: page.description,
      content: markdown.text
    }),
    summary: { path: page.path, locale: page.locale, chars: markdown.text.length, truncated: markdown.truncated }
  }
}

/**
 * One uploaded file as text, from the index rather than from the file
 * again: the extraction has already been done, and the chunks carry where
 * in the file each part came from. The reader's own access is still
 * checked against Wiki.js first.
 */
async function getDocument (ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const rawPath = asString(input.path)
  if (!rawPath) { return fail('get_document needs a "path".') }
  if (!ctx.index) { return fail('Uploaded files are not indexed here.') }

  const path = rawPath.replace(/^\/+/, '').split('#')[0] ?? ''
  const document = await findDocumentByPath(ctx.index, path)
  if (!document) {
    return fail(`There is no indexed file at "${path}". Use the path exactly as search_wiki returned it.`)
  }
  if (!await ctx.client.canReadAsset(path)) {
    return fail('That file is not readable with your account.')
  }
  if (document.status !== 'indexed') {
    return fail(`That file has no searchable text: ${document.reason || document.status}.`)
  }

  const chunks = await documentChunks(ctx.index, document.id)
  const body = chunks
    .map(chunk => (chunk.location ? `## ${chunk.location}\n\n${stripPrefix(chunk.text)}` : stripPrefix(chunk.text)))
    .join('\n\n')
  const content = trimForContext(body, MAX_PAGE_CHARS)

  const source = ctx.sources.register({
    kind: 'document',
    title: document.fileName,
    path: document.path,
    fileName: document.fileName,
    fileType: document.docType,
    snippet: firstLine(body),
    updatedAt: document.updatedAt,
    read: true
  })

  return {
    result: JSON.stringify({
      id: source.id,
      kind: 'document',
      fileName: document.fileName,
      fileType: document.docType,
      path: document.path,
      url: source.url,
      updatedAt: document.updatedAt,
      fileSize: document.fileSize,
      note: 'Each "## …" heading is where in the file the text below it came from. Cite the file with its id.',
      content: content.text
    }),
    summary: {
      path: document.path,
      fileType: document.docType,
      parts: chunks.length,
      chars: content.text.length,
      truncated: content.truncated
    }
  }
}

/** A chunk repeats "file name › location" at the top; the heading says it. */
function stripPrefix (text: string): string {
  const at = text.indexOf('\n\n')
  return at > 0 && at < 200 ? text.slice(at + 2) : text
}

function firstLine (body: string): string {
  const line = body.split('\n').find(part => part.trim().length > 0 && !part.startsWith('## '))
  return (line ?? '').trim().slice(0, 300)
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
