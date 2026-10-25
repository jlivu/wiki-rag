/**
 * The chat app at /ai/panel/.
 *
 * In production these are the files Vite built into panel-ui/dist. In
 * development the Caddy proxy sends /ai/panel* to the Vite dev server
 * instead, so this route is only reached if that container is not running —
 * in which case it says so rather than 404ing.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'

import { PANEL_PATH } from '../../shared/index.js'

/** Both `npm run dev` and `npm start` run from the service root. */
const PANEL_DIST = process.env.PANEL_DIST ?? resolve(process.cwd(), 'panel-ui', 'dist')

const PANEL_PATH_NO_SLASH = PANEL_PATH.replace(/\/$/, '')

export const panelRoutes: FastifyPluginAsync = async (app) => {
  // Keep the query string: it carries the page the reader is on.
  app.get(PANEL_PATH_NO_SLASH, async (request, reply) => {
    const query = queryStringOf(request.raw.url)
    return reply.redirect(`${PANEL_PATH}${query}`, 302)
  })

  // Applies to every route in this plugin, including @fastify/static's.
  app.addHook('onSend', async (request, reply) => {
    // Only the wiki, on this same origin, may frame the panel.
    reply.header('content-security-policy', "frame-ancestors 'self'")
    if (isHtmlPath(request.url)) {
      // The page itself names the current build's files, so it must never
      // be held: a stale copy would load assets that no longer exist.
      reply.header('cache-control', 'no-store')
    } else if (isHashedAsset(request.url)) {
      // Vite puts a content hash in every built file name, so a given URL
      // never changes. A year, and never revalidated.
      reply.header('cache-control', 'public, max-age=31536000, immutable')
    }
  })

  if (existsSync(resolve(PANEL_DIST, 'index.html'))) {
    app.log.info({ dir: PANEL_DIST }, 'serving the built chat app')
    await app.register(fastifyStatic, {
      root: PANEL_DIST,
      prefix: PANEL_PATH,
      index: ['index.html']
    })
    return
  }

  app.log.warn({ dir: PANEL_DIST }, 'no chat app build found; serving the placeholder')
  app.get(PANEL_PATH, async (_request, reply) => notBuilt(reply))
  app.get(`${PANEL_PATH}*`, async (_request, reply) => notBuilt(reply))
}

function queryStringOf (url: string | undefined): string {
  const start = url?.indexOf('?') ?? -1
  return start >= 0 ? (url as string).slice(start) : ''
}

/**
 * A built file with a content hash in its name, e.g.
 * /ai/panel/assets/index-Bz42JpH5.js. Vite writes every one of these; a
 * file without a hash is served normally and revalidated.
 */
function isHashedAsset (url: string): boolean {
  const [path = ''] = url.split('?')
  return /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path)
}

/** A directory listing or an .html file, i.e. the page itself. */
function isHtmlPath (url: string): boolean {
  const [path = ''] = url.split('?')
  return path.endsWith('/') || path.endsWith('.html')
}

function notBuilt (reply: FastifyReply): FastifyReply {
  return reply
    .code(503)
    .type('text/html; charset=utf-8')
    .send(`<!DOCTYPE html>
<meta charset="utf-8">
<title>Assistant</title>
<style>
  body { margin: 0; padding: 14px 13px; background: #f5f5f5; color: rgba(0,0,0,.87);
         font: 13.5px/1.6 Roboto, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  div { padding: 11px 13px; border: 1px solid rgba(0,0,0,.12); border-radius: 11px 11px 11px 3px; background: #fff; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
</style>
<div>
  <strong>The chat app is not built.</strong><br>
  Start the development containers, or build it with
  <code>npm run build</code> in <code>ai/panel-ui</code>.
</div>`)
}
