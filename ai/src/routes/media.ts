/**
 * Serving the videos, at /ai/media/.
 *
 * Wiki.js is not in the way here, so the two things it would have done
 * are done here instead: only a signed-in reader gets a byte, and the
 * response supports range requests so a browser can seek — which is the
 * whole point of a citation that says "14:02".
 *
 * The folder is mounted read-only and nothing in this file writes to it.
 * Only videos and the subtitle files beside them are served; anything
 * else in the folder is not reachable.
 */
import fastifyStatic from '@fastify/static'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'

import type { Config } from '../config.js'
import { McpAuth } from '../mcp/auth.js'
import { isSubtitlePath, isVideoPath, MediaLibrary } from '../media/library.js'
import { readWikiToken } from '../wiki/client.js'
import { MEDIA_PATH, mediaUrl } from '../../shared/index.js'

/** A video is a lot of requests; a long cache saves re-asking the wiki. */
const CACHE_SECONDS = 300

export function mediaRoutes (config: Config): FastifyPluginAsync {
  const library = new MediaLibrary(config.media.directory)
  // The same probe the MCP server uses on an API key: Wiki.js answers
  // users.profile for somebody and refuses it for the guest account. It
  // caches for a minute, which matters because one video is dozens of
  // range requests.
  const auth = new McpAuth(config.wikiUrl)

  return async (app) => {
    if (!await library.available()) {
      app.log.info({ directory: library.root }, 'no media folder; /ai/media is off')
      app.get(`${MEDIA_PATH}*`, async (_request, reply) =>
        reply.code(404).send({ error: 'No media folder is configured on this wiki.' }))
      return
    }

    await app.register(async (scope) => {
      scope.addHook('onRequest', async (request, reply) => {
        const path = mediaPathOf(request)
        // Only the files we index, and the subtitles that go with them.
        if (!isVideoPath(path) && !isSubtitlePath(path)) {
          return reply.code(404).send({ error: 'Not found.' })
        }

        const token = readWikiToken(request)
        if (!token) {
          return reply.code(401).send({ error: 'Sign in to the wiki to watch this video.' })
        }
        const check = await auth.check(token)
        if (!check.valid) {
          return reply.code(401).send({ error: 'Sign in to the wiki to watch this video.' })
        }
        return undefined
      })

      scope.addHook('onSend', async (_request, reply) => {
        // Per reader, never by a shared cache: the answer depends on who
        // is asking.
        reply.header('cache-control', `private, max-age=${CACHE_SECONDS}`)
        reply.header('x-content-type-options', 'nosniff')
      })

      await scope.register(fastifyStatic, {
        root: library.root,
        prefix: MEDIA_PATH,
        index: false,
        // No directory listings, and nothing reached through a symlink
        // pointing out of the folder.
        list: false,
        serveDotFiles: false,
        // @fastify/static answers byte ranges, which is what lets the
        // browser seek to the cited moment without fetching the lot.
        acceptRanges: true,
        lastModified: true,
        etag: true,
        setHeaders: (response, path) => {
          response.header('content-type', contentTypeOf(path))
        }
      })
    })

    app.log.info({ directory: library.root, prefix: MEDIA_PATH }, 'serving videos from the media folder')

    /** What the folder holds, for a page that wants to list it. */
    app.get(`${MEDIA_PATH.replace(/\/$/, '')}.json`, async (request, reply) => {
      const token = readWikiToken(request)
      if (!token || !(await auth.check(token)).valid) {
        return reply.code(401).send({ error: 'Sign in to the wiki to list the videos.' })
      }
      const files = await library.list()
      return reply.send({
        videos: files.map(file => ({
          path: file.path,
          fileName: file.fileName,
          url: mediaUrl(file.path),
          fileSize: file.fileSize,
          modifiedAt: file.modifiedAt,
          subtitles: file.subtitlePath !== null
        }))
      })
    })
  }
}

/** The part after /ai/media/, decoded, without the query or the fragment. */
function mediaPathOf (request: FastifyRequest): string {
  const [withoutQuery = ''] = request.url.split('?')
  const raw = withoutQuery.slice(MEDIA_PATH.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Browsers are particular about video types: a .mov served as
 * application/octet-stream will not play, and Safari refuses a subtitle
 * track that is not text/vtt.
 */
function contentTypeOf (path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) { return 'video/mp4' }
  if (lower.endsWith('.mov')) { return 'video/quicktime' }
  if (lower.endsWith('.webm')) { return 'video/webm' }
  if (lower.endsWith('.vtt')) { return 'text/vtt; charset=utf-8' }
  if (lower.endsWith('.srt')) { return 'application/x-subrip; charset=utf-8' }
  return 'application/octet-stream'
}

