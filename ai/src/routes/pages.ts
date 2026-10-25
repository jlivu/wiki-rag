/**
 * The one route in this service that changes the wiki.
 *
 * It exists for a single gesture: a person reading a draft card and
 * pressing "Create page". The model cannot reach it — it has no tool for
 * it, and nothing in an answer can cause a request — so a page is only
 * ever created because someone clicked.
 *
 * Because it writes, it is stricter than the rest: JSON only, the Origin
 * must be the wiki's own, and the page is created with the reader's token
 * and nothing else. Wiki.js then applies that reader's permissions, so
 * this route grants no authority of its own.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'

import type { Config } from '../config.js'
import { createPage } from '../wiki/pages.js'
import { WikiClient, readWikiToken } from '../wiki/client.js'
import { PAGES_PATH, type CreatePageRequest } from '../../shared/index.js'

export function pageRoutes (config: Config): FastifyPluginAsync {
  const allowedOrigins = originsOf(config)

  return async (app) => {
    app.post(PAGES_PATH, async (request, reply) => {
      // A form post from another site cannot be JSON, and a browser will
      // not send this content type cross-origin without a preflight.
      const contentType = request.headers['content-type'] ?? ''
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return reply.code(415).send({ ok: false, reason: 'failed', error: 'Send the page as JSON.' })
      }

      // The panel is framed by the wiki on the same origin, so a request
      // that comes from anywhere else is not the panel.
      const origin = request.headers.origin
      if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
        request.log.warn({ origin: origin ?? null }, 'pages: refused a foreign origin')
        return reply.code(403).send({
          ok: false,
          reason: 'forbidden',
          error: 'That request did not come from the wiki.'
        })
      }

      const token = readWikiToken(request)
      if (token === null) {
        return reply.code(401).send({
          ok: false,
          reason: 'forbidden',
          error: 'Log in to create pages.'
        })
      }

      const body = (request.body ?? {}) as Partial<CreatePageRequest>
      const title = typeof body.title === 'string' ? body.title : ''
      const path = typeof body.path === 'string' ? body.path : ''
      const content = typeof body.content === 'string' ? body.content : ''
      const locale = typeof body.locale === 'string' && body.locale.trim().length > 0
        ? body.locale.trim()
        : config.index.defaultLocale

      if (title.trim().length === 0 || path.trim().length === 0 || content.trim().length === 0) {
        return reply.code(400).send({
          ok: false,
          reason: 'failed',
          error: 'A page needs a title, a path and some content.'
        })
      }

      // The reader's own token and nothing else: no admin key is in scope
      // here, and Wiki.js decides whether they may write at this path.
      const wiki = new WikiClient(config.wikiUrl, token)
      const startedAt = Date.now()
      const result = await createPage(wiki, {
        title,
        path,
        content,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        locale
      }, { publicUrl: config.wikiPublicUrl, who: 'reader' })

      // Who made what, never what was in it.
      if (result.ok) {
        request.log.info({
          reader: fingerprint(token),
          pageId: result.page.id,
          path: result.page.path,
          locale: result.page.locale,
          ms: Date.now() - startedAt
        }, 'created a page from a draft card')
        return reply.code(201).send(result)
      }

      request.log.info({
        reader: fingerprint(token),
        path,
        locale,
        reason: result.reason,
        ms: Date.now() - startedAt
      }, 'a draft page was not created')
      return reply.code(statusFor(result.reason)).send(result)
    })
  }
}

/** The origins the panel can legitimately be served from. */
function originsOf (config: Config): string[] {
  const origins = new Set<string>()
  for (const url of [config.wikiPublicUrl, config.wikiUrl]) {
    try {
      origins.add(new URL(url).origin)
    } catch {
      // A malformed setting simply contributes no origin.
    }
  }
  for (const extra of config.mcp.allowedOrigins) { origins.add(extra) }
  return [...origins]
}

function statusFor (reason: string): number {
  switch (reason) {
    case 'exists': return 409
    case 'forbidden': return 403
    case 'path': return 400
    case 'unavailable': return 503
    default: return 400
  }
}

/** Enough to follow one reader through the log, never their token. */
function fingerprint (token: string): string {
  let hash = 0
  for (let at = 0; at < token.length; at++) {
    hash = (hash * 31 + token.charCodeAt(at)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export type { FastifyRequest }
