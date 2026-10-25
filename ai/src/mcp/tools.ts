/**
 * The four tools the MCP server offers.
 *
 * Everything here reuses what the panel already uses: the hybrid retriever
 * for search, the reader-scoped WikiClient for reading a page, and Wiki.js
 * itself for listing and creating. The only difference is who the reader is
 * — an API key rather than a browser cookie — and Wiki.js applies that key's
 * group permissions either way.
 */
import type { Pool } from 'pg'

import { documentChunks, findDocumentByPath } from '../index-db/search.js'
import type { Retriever } from '../indexer/retrieval.js'
import { forgetStaleDocument } from '../indexer/stale.js'
import { WikiClient, WikiError } from '../wiki/client.js'
import { createPage } from '../wiki/pages.js'
import { AI_DRAFT_TAG } from '../../shared/index.js'
import { htmlToMarkdown, trimForContext } from '../wiki/markdown.js'

/** A page body longer than this is cut, with a note saying so. */
const MAX_PAGE_CHARS = 24000
const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 20
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 500
/** Folder reads while walking the tree, so a deep wiki cannot hang a call. */
const MAX_TREE_CALLS = 80
const DRAFT_PREFIX = 'drafts/'

export interface McpToolContext {
  /** Reads the wiki as the key that made the request. */
  wiki: WikiClient
  token: string
  /** Shared with the panel; its permission filter runs as this reader. */
  retriever: Retriever | null
  /** The index itself, for reading an uploaded file's extracted text. */
  index: Pool | null
  defaultLocale: string
  /** Where a human would open a page, for citations. */
  publicUrl: string
}

export interface ToolResult {
  /** JSON text handed back to the agent. */
  text: string
  isError?: boolean
}

export function pageUrl (publicUrl: string, locale: string, path: string, anchor = ''): string {
  return `${publicUrl}/${locale}/${path.replace(/^\/+/, '')}${anchor}`
}

/** An uploaded file sits at the site root, with no locale segment. */
export function fileUrl (publicUrl: string, path: string, anchor = ''): string {
  return `${publicUrl}/${path.replace(/^\/+/, '')}${anchor}`
}

/* ── search_wiki ───────────────────────────────────────────────────── */

export async function searchWiki (
  ctx: McpToolContext,
  args: { query?: unknown, limit?: unknown }
): Promise<ToolResult> {
  const query = asString(args.query)
  if (!query) { return error('search_wiki needs a "query".') }
  const limit = clamp(asInt(args.limit) ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
  const locale = ctx.defaultLocale

  if (!ctx.retriever) { return error('The wiki index is not available.') }

  const found = await ctx.retriever.search(query, locale, limit, ctx.wiki, ctx.token)
  return ok({
    query,
    results: found.results.map(item => (
      item.kind === 'document'
        ? {
            kind: 'document',
            title: item.fileName,
            fileName: item.fileName,
            fileType: item.docType,
            path: item.path,
            // Straight to the page of the PDF, where the format allows it.
            url: fileUrl(ctx.publicUrl, item.path, item.anchor),
            location: item.location,
            ...(item.origin ? { origin: item.origin } : {}),
            ...(item.origin === 'description'
              ? { note: 'This text is a generated description of the image, not text printed in it.' }
              : {}),
            snippet: item.snippet,
            updatedAt: item.updatedAt,
            ...(item.linkedFrom.length > 0
              ? {
                  linkedFrom: item.linkedFrom.map(page => ({
                    title: page.title,
                    url: pageUrl(ctx.publicUrl, page.locale, page.path)
                  }))
                }
              : {}),
            score: item.score
          }
        : {
            kind: 'page',
            title: item.title,
            path: item.path,
            locale: item.locale,
            // Straight to the section that matched.
            url: pageUrl(ctx.publicUrl, item.locale, item.path, item.anchor),
            heading: item.heading,
            snippet: item.snippet,
            updatedAt: item.updatedAt,
            score: item.score
          }
    )),
    ...(found.results.length === 0 ? { note: 'Nothing matched. Try different wording.' } : {})
  })
}

/* ── get_document ──────────────────────────────────────────────────── */

export async function getDocument (
  ctx: McpToolContext,
  args: { path?: unknown }
): Promise<ToolResult> {
  const rawPath = asString(args.path)
  if (!rawPath) { return error('get_document needs a "path".') }
  if (!ctx.index) { return error('Uploaded files are not indexed here.') }

  const path = rawPath.replace(/^\/+/, '').split('#')[0] ?? ''
  const document = await findDocumentByPath(ctx.index, path)
  if (!document) {
    return error(`There is no indexed file at "${path}". Use the path exactly as search_wiki returned it.`)
  }
  // The key's own access, checked against Wiki.js, exactly as for a page.
  const access = await ctx.wiki.canReadAsset(path)
  if (access === 'missing') {
    await forgetStaleDocument(ctx.index, document.id, path)
    return error(`There is no file at /${path} any more; it has been dropped from the index.`)
  }
  if (access !== 'yes') {
    return error(`This key is not allowed to read /${path}.`)
  }
  if (document.status !== 'indexed') {
    return error(`That file has no searchable text: ${document.reason || document.status}.`)
  }

  const chunks = await documentChunks(ctx.index, document.id)
  const body = chunks
    .map(chunk => (chunk.location ? `## ${chunk.location}\n\n${stripPrefix(chunk.text)}` : stripPrefix(chunk.text)))
    .join('\n\n')
  const trimmed = trimForContext(body, MAX_PAGE_CHARS)

  return ok({
    kind: 'document',
    fileName: document.fileName,
    fileType: document.docType,
    path: document.path,
    url: fileUrl(ctx.publicUrl, document.path),
    updatedAt: document.updatedAt,
    fileSize: document.fileSize,
    truncated: trimmed.truncated,
    note: 'Each "## …" heading says where in the file the text below it came from; cite that with the url.',
    content: trimmed.text
  })
}

/** A chunk repeats "file name › location" at the top; the heading says it. */
function stripPrefix (text: string): string {
  const at = text.indexOf('\n\n')
  return at > 0 && at < 200 ? text.slice(at + 2) : text
}

/* ── get_page ──────────────────────────────────────────────────────── */

export async function getPage (
  ctx: McpToolContext,
  args: { path?: unknown, locale?: unknown }
): Promise<ToolResult> {
  const rawPath = asString(args.path)
  if (!rawPath) { return error('get_page needs a "path".') }
  const locale = asString(args.locale) ?? ctx.defaultLocale
  const path = rawPath.replace(/^\/+/, '').replace(new RegExp(`^${locale}/`), '')

  try {
    const page = await ctx.wiki.fetchPage(path, locale)
    const trimmed = trimForContext(htmlToMarkdown(page.html), MAX_PAGE_CHARS)
    return ok({
      title: page.title,
      path: page.path,
      locale: page.locale,
      url: pageUrl(ctx.publicUrl, page.locale, page.path),
      updatedAt: page.updatedAt,
      description: page.description,
      truncated: trimmed.truncated,
      content: trimmed.text
    })
  } catch (err) {
    if (err instanceof WikiError) {
      return error(err.status === 403
        ? `This key is not allowed to read /${locale}/${path}.`
        : `The wiki could not return /${locale}/${path}: ${err.message}.`)
    }
    throw err
  }
}

/* ── list_pages ────────────────────────────────────────────────────── */

interface TreeItem {
  id: number
  path: string
  title: string
  locale: string
  isFolder: boolean
  pageId: number | null
}

const TREE_QUERY = `
  query AiMcpTree($parent: Int!, $locale: String!) {
    pages {
      tree(parent: $parent, mode: ALL, locale: $locale) {
        id path title locale isFolder pageId
      }
    }
  }
`

/**
 * Wiki.js filters its own page tree with the caller's read permission
 * (server/graph/resolvers/page.js), so walking the tree gives a list that
 * is already correct for this key — unlike `pages.list`, which returns
 * every page regardless.
 */
export async function listPages (
  ctx: McpToolContext,
  args: { prefix?: unknown, limit?: unknown }
): Promise<ToolResult> {
  const prefix = (asString(args.prefix) ?? '').replace(/^\/+/, '')
  const limit = clamp(asInt(args.limit) ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
  const locale = ctx.defaultLocale

  const pages: Array<{ title: string, path: string, url: string }> = []
  const queue: number[] = [0]
  let calls = 0
  let truncated = false

  while (queue.length > 0 && pages.length < limit) {
    if (calls >= MAX_TREE_CALLS) { truncated = true; break }
    const parent = queue.shift() as number
    calls += 1

    const data = await ctx.wiki.graphql<{ pages: { tree: TreeItem[] } }>(TREE_QUERY, { parent, locale })
    for (const item of data.pages.tree) {
      if (item.isFolder) {
        // Only walk into a folder that could hold something matching.
        if (couldContain(item.path, prefix)) { queue.push(item.id) }
        continue
      }
      if (prefix.length > 0 && !item.path.startsWith(prefix)) { continue }
      if (pages.length >= limit) { truncated = true; break }
      pages.push({
        title: item.title,
        path: item.path,
        url: pageUrl(ctx.publicUrl, item.locale, item.path)
      })
    }
  }

  pages.sort((a, b) => a.path.localeCompare(b.path))
  return ok({
    prefix: prefix || null,
    locale,
    count: pages.length,
    ...(truncated ? { truncated: true, note: `Only the first ${pages.length} pages are listed.` } : {}),
    pages
  })
}

/** A folder is worth opening if it is on the way to the prefix, or inside it. */
function couldContain (folderPath: string, prefix: string): boolean {
  if (prefix.length === 0) { return true }
  return prefix.startsWith(folderPath) || folderPath.startsWith(prefix)
}

/* ── create_draft_page ─────────────────────────────────────────────── */

export async function createDraftPage (
  ctx: McpToolContext,
  args: { title?: unknown, path?: unknown, content?: unknown, description?: unknown }
): Promise<ToolResult> {
  const title = asString(args.title)
  const rawPath = asString(args.path)
  const content = asString(args.content)
  if (!title) { return error('create_draft_page needs a "title".') }
  if (!rawPath) { return error('create_draft_page needs a "path".') }
  if (!content) { return error('create_draft_page needs "content".') }

  const locale = ctx.defaultLocale
  // An agent writes under drafts/ whether or not it said so. A person
  // pressing the button on a draft card may choose the path; an agent
  // may not.
  const result = await createPage(ctx.wiki, {
    title,
    path: draftPath(rawPath, locale),
    content,
    description: asString(args.description) ?? `Draft created by an AI agent. ${title}`,
    locale
  }, { publicUrl: ctx.publicUrl, who: 'key' })

  if (!result.ok) { return error(result.error) }

  return ok({
    created: true,
    id: result.page.id,
    title: result.page.title,
    path: result.page.path,
    locale: result.page.locale,
    url: result.page.viewUrl,
    isPublished: false,
    tags: [AI_DRAFT_TAG],
    note: 'This page is a draft. It is not published, it does not appear in the wiki or in search, and a person has to review and publish it before anyone can read it.'
  })
}

/** Drafts live under drafts/, whether or not the agent said so. */
export function draftPath (rawPath: string, locale: string): string {
  let path = rawPath.trim().replace(/^\/+|\/+$/g, '')
  if (path.startsWith(`${locale}/`)) { path = path.slice(locale.length + 1) }
  if (!path.startsWith(DRAFT_PREFIX)) { path = `${DRAFT_PREFIX}${path}` }
  return path
}

/* ── helpers ───────────────────────────────────────────────────────── */

function ok (payload: unknown): ToolResult {
  return { text: JSON.stringify(payload, null, 2) }
}

function error (message: string): ToolResult {
  return { text: JSON.stringify({ error: message }, null, 2), isError: true }
}

function asString (value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asInt (value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined
}

function clamp (value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
