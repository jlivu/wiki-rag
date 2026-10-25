/**
 * Indexing one page.
 */
import type { Pool } from 'pg'

import {
  documentIdsByPath, existingEmbeddings, imagePathsOnPage, readPage, removePage,
  replaceDocumentLinks, replaceImageText, replacePage, touchPage, type PageImageText
} from '../index-db/store.js'
import type { QueuedJob } from '../index-db/queue.js'
import { htmlToMarkdown } from '../wiki/markdown.js'
import type { WikiAdminClient, WikiPageSource } from '../wiki/admin-client.js'

import { chunkMarkdown, estimateTokens, hash } from './chunker.js'
import { toVectorLiteral, type Embedder } from './embeddings.js'
import { assetLinksFrom, assetPathOf, type LinkScanOptions } from './links.js'
import { imagesIn } from './page-images.js'
import { tocFromRender } from './toc.js'

export interface JobOutcome {
  action: 'indexed' | 'skipped' | 'removed'
  chunks?: number
  embedded?: number
  /** How many uploaded files this page links to. */
  links?: number
  reason?: string
  /** Whatever the job wants in its log line: OCR pages, describer tokens. */
  [key: string]: unknown
}

export async function runJob (
  db: Pool,
  wiki: WikiAdminClient,
  embedder: Embedder,
  job: QueuedJob,
  links: LinkScanOptions,
  /** Images whose alt text changed are re-indexed; the caller queues them. */
  requeueDocuments?: (ids: number[]) => Promise<void>
): Promise<JobOutcome> {
  if (job.event === 'deleted') {
    await removePage(db, job.entityId)
    return { action: 'removed', reason: 'deleted' }
  }

  const page = await wiki.fetchPage(job.entityId)
  if (!page) {
    await removePage(db, job.entityId)
    return { action: 'removed', reason: 'gone' }
  }
  if (!page.isPublished) {
    // An unpublished page is invisible to readers, so it leaves the index.
    await removePage(db, job.entityId)
    return { action: 'removed', reason: 'unpublished' }
  }

  const markdown = toMarkdown(page)
  const sourceHash = hash(markdown)
  const indexed = await readPage(db, job.entityId)

  if (indexed && indexed.sourceHash === sourceHash && indexed.path === page.path && indexed.locale === page.locale) {
    await touchPage(db, job.entityId, page.updatedAt)
    return { action: 'skipped', reason: 'unchanged' }
  }

  // Section anchors come from the rendered page's own heading ids, which
  // are what Wiki.js builds its table of contents from.
  const chunks = chunkMarkdown(markdown, page.title ?? page.path, tocFromRender(page.render))

  // A chunk whose text is unchanged keeps the vector it already has; a
  // rename or an edit elsewhere on the page costs nothing to embed.
  const reusable = await existingEmbeddings(db, job.entityId)
  const fresh = chunks.filter(chunk => !reusable.has(chunk.contentHash))
  const vectors = await embedder.embed(fresh.map(chunk => chunk.text))

  const byHash = new Map(reusable)
  fresh.forEach((chunk, at) => {
    const vector = vectors[at]
    if (vector) { byHash.set(chunk.contentHash, toVectorLiteral(vector)) }
  })

  const rows = chunks.flatMap(chunk => {
    const embeddingLiteral = byHash.get(chunk.contentHash)
    return embeddingLiteral ? [{ ...chunk, embedding: null, embeddingLiteral }] : []
  })

  await replacePage(db, {
    id: page.id,
    path: page.path,
    locale: page.locale,
    title: page.title ?? '',
    description: page.description ?? '',
    contentType: page.contentType,
    sourceHash,
    updatedAt: page.updatedAt
  }, rows, embedder.model)

  // Which files this page points at, for the "Linked from" line a document
  // source carries. The page has to exist in the index first.
  const linked = assetLinksFrom(page.render, links)
  await replaceDocumentLinks(db, page.id, linked)

  // What this page calls the images it shows. An image is indexed with
  // that text, so a change here has to reach the image as well.
  const before = await imagePathsOnPage(db, page.id)
  const images = pageImageText(page.render, links)
  await replaceImageText(db, page.id, images)

  if (requeueDocuments) {
    const touched = [...new Set([...before, ...images.map(image => image.assetPath)])]
    const ids = await documentIdsByPath(db, touched)
    if (ids.length > 0) { await requeueDocuments(ids) }
  }

  return {
    action: 'indexed',
    chunks: rows.length,
    embedded: fresh.length,
    ...(linked.length > 0 ? { links: linked.length } : {}),
    ...(images.length > 0 ? { images: images.length } : {})
  }
}

/** The alt text and captions this page gives the images it shows. */
function pageImageText (html: string, links: LinkScanOptions): PageImageText[] {
  return imagesIn(html).flatMap(image => {
    const path = assetPathOf(image.src, links)
    if (!path) { return [] }
    if (image.alt.length === 0 && image.caption.length === 0) { return [] }
    return [{ assetPath: path, alt: image.alt, caption: image.caption }]
  })
}

/**
 * Wiki.js keeps the source as it was written and a rendered copy. Markdown
 * pages index their source; everything else indexes the rendered HTML turned
 * back into Markdown, so one format reaches the model.
 */
export function toMarkdown (page: WikiPageSource): string {
  if (page.contentType === 'markdown' && page.content.trim().length > 0) {
    return page.content
  }
  if (page.render && page.render.trim().length > 0) {
    return htmlToMarkdown(page.render)
  }
  return page.content ?? ''
}

export { estimateTokens }
