/**
 * The MCP server definition: four tools over the wiki, described for an
 * agent rather than for a person.
 *
 * One server is built per request. The transport is stateless, and every
 * tool closes over the key that made the request, so two agents with
 * different keys can never see each other's view of the wiki.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  createDraftPage, getPage, listPages, searchWiki,
  type McpToolContext, type ToolResult
} from './tools.js'

export const MCP_SERVER_NAME = 'wiki'
export const MCP_SERVER_VERSION = '0.1.0'

export interface ToolCallRecord {
  tool: string
  ms: number
  chars: number
  isError: boolean
}

export function buildMcpServer (
  ctx: McpToolContext,
  record: (call: ToolCallRecord) => void
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: [
        'This server reads one Wiki.js wiki. Search it before answering anything about what the',
        'organisation documents: the wiki is the source of truth and your own knowledge is not.',
        'Start with search_wiki, then read the pages that look relevant with get_page — a snippet is',
        'an extract, not the page. Cite what you use by its url. Everything you can see here is',
        'everything the API key is allowed to see; a page that is missing may simply be one this key',
        'cannot read.'
      ].join(' ')
    }
  )

  const run = <A>(tool: string, handler: (args: A) => Promise<ToolResult>) => async (args: A) => {
    const startedAt = Date.now()
    try {
      const result = await handler(args)
      record({ tool, ms: Date.now() - startedAt, chars: result.text.length, isError: result.isError === true })
      return {
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.isError ? { isError: true } : {})
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      record({ tool, ms: Date.now() - startedAt, chars: 0, isError: true })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
        isError: true
      }
    }
  }

  server.registerTool('search_wiki', {
    title: 'Search the wiki',
    description: [
      'Search the wiki and get back the pages that match, each with the part that matched.',
      'Searches the words on the page as well as its title, so a plain question works as well as',
      'keywords. Use this first, before answering anything the wiki might cover; search again with',
      'different wording if nothing comes back. Results carry a url you can cite. The snippets are',
      'extracts — read a page with get_page before relying on it.'
    ].join(' '),
    inputSchema: {
      query: z.string().min(1).describe('What to look for. A question or a few keywords.'),
      limit: z.number().int().min(1).max(20).optional().describe('How many pages to return. Defaults to 8.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, run('search_wiki', args => searchWiki(ctx, args)))

  server.registerTool('get_page', {
    title: 'Read a wiki page',
    description: [
      'Read one wiki page as Markdown, by the path that search_wiki returned. Returns the title,',
      'path, url, last-updated date and the page body; a very long page is cut and says so. Use it',
      'for every page you intend to quote, summarise or cite.'
    ].join(' '),
    inputSchema: {
      path: z.string().min(1).describe('Page path without the locale, e.g. "ops/backup-and-restore".'),
      locale: z.string().optional().describe('Locale code. Defaults to the wiki\'s own.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, run('get_page', args => getPage(ctx, args)))

  server.registerTool('list_pages', {
    title: 'List wiki pages',
    description: [
      'List the titles and paths of pages, for browsing rather than searching. Give a prefix such as',
      '"ops/" to list one part of the wiki. Use it to find out what exists when you do not have good',
      'keywords; use search_wiki when you do.'
    ].join(' '),
    inputSchema: {
      prefix: z.string().optional().describe('Only list pages whose path starts with this, e.g. "ops/".'),
      limit: z.number().int().min(1).max(500).optional().describe('How many pages to return. Defaults to 100.')
    },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, run('list_pages', args => listPages(ctx, args)))

  server.registerTool('create_draft_page', {
    title: 'File a draft page for review',
    description: [
      'Write a new page into the wiki as an unpublished draft under drafts/, tagged ai-draft, for a',
      'person to review. It is not published: nobody can read it in the wiki and it stays out of',
      'search until someone publishes it. Use it to propose documentation the wiki is missing —',
      'search first, so you do not duplicate a page that already exists. Returns the url to share',
      'with whoever will review it.'
    ].join(' '),
    inputSchema: {
      title: z.string().min(1).describe('The page title.'),
      path: z.string().min(1).describe('Suggested path, lower case with hyphens. "drafts/" is added if you leave it out.'),
      content: z.string().min(1).describe('The page body, in Markdown.'),
      description: z.string().optional().describe('One line describing the page, shown in listings and search.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, run('create_draft_page', args => createDraftPage(ctx, args)))

  return server
}
