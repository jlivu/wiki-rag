/**
 * Indexing one picture.
 *
 * An image has no text of its own, so three sources are tried and each is
 * kept as its own chunk, labelled with where it came from:
 *
 *   Text in image   what Tesseract reads in it, locally and for nothing
 *   Alt text        what the wiki pages that show it call it
 *   AI description  what a vision model says is in it, if that is on
 *
 * The third is the only one that leaves this machine. Before it does, the
 * image is stripped of its metadata and resized (images/prepare.ts), its
 * folder is checked against the exclude list, the day's allowance is
 * checked, and the description is looked up by the image's content hash so
 * the same picture is never paid for twice.
 */
import type { Pool } from 'pg'

import { chunkDocument, type DocChunk } from '../documents/chunk.js'
import type { DocSection } from '../documents/types.js'
import type { ImageDescriber } from '../images/describe.js'
import { ocrImage } from '../images/ocr.js'
import { prepareImage, readTakenAt } from '../images/prepare.js'
import {
  describedToday, imageTextFor, readDescription, saveDescription
} from '../index-db/store.js'

/** What a chunk's origin is called where a reader can see it. */
export const ORIGIN_LABELS: Record<string, string> = {
  ocr: 'Text in image',
  alt: 'Alt text',
  description: 'AI description'
}

export interface ImageTextOptions {
  /** Folders whose images are never sent to a model, by path prefix. */
  excludeFolders: readonly string[]
  dailyLimit: number
  describer: ImageDescriber
}

export interface ImageTextResult {
  chunks: DocChunk[]
  ocrChars: number
  altSources: number
  described: 'fresh' | 'cached' | 'off' | 'excluded' | 'over-limit' | 'unreadable' | 'empty'
  describeModel?: string
  describeInputTokens?: number
  describeOutputTokens?: number
  describeMs?: number
  /** The size the image was sent at, when it was sent. */
  sentPixels?: string
  sentTokens?: number
  takenAt?: string
}

export async function readImage (
  db: Pool,
  bytes: Buffer,
  file: { path: string, fileName: string, ext: string },
  contentHash: string,
  options: ImageTextOptions
): Promise<ImageTextResult> {
  const sections: DocSection[] = []

  // 1. The text in the picture. Tesseract reads the original, not the
  //    resized copy: it is sharper, and it never leaves the machine.
  const ocr = await ocrImage(bytes, file.ext || '.png')
  if (ocr.text.length > 0) {
    sections.push({ label: ORIGIN_LABELS.ocr as string, origin: 'ocr', anchor: '', text: ocr.text })
  }

  // 2. What the pages that show it call it.
  const described = await imageTextFor(db, file.path)
  const altText = described
    .map(entry => [entry.alt, entry.caption].filter(part => part.length > 0).join(' — '))
    .filter(line => line.length > 0)
  if (altText.length > 0) {
    sections.push({
      label: ORIGIN_LABELS.alt as string,
      origin: 'alt',
      anchor: '',
      text: [...new Set(altText)].join('\n')
    })
  }

  // 3. A description, if that is switched on and allowed here.
  const description = await describeOnce(db, bytes, file, contentHash, options)

  // The capture date is read whether or not anything was described: it is
  // worth searching for, and it is the one EXIF field we keep. The
  // position is never read at all.
  const takenAt = await readTakenAt(bytes)
  if (description.text) {
    sections.push({
      label: ORIGIN_LABELS.description as string,
      origin: 'description',
      anchor: '',
      // Said plainly in the indexed text as well as in the card, so the
      // model answering a question knows it is reading a description.
      text: `Generated description of this image:\n${description.text}`
    })
  }

  if (takenAt && sections.length > 0) {
    const first = sections[0] as DocSection
    first.text = `Photographed ${takenAt.slice(0, 10)}.\n${first.text}`
  }

  return {
    chunks: chunkDocument(file.fileName, sections),
    ocrChars: ocr.text.length,
    altSources: altText.length,
    described: description.outcome,
    ...(description.model ? { describeModel: description.model } : {}),
    ...(description.inputTokens !== undefined ? { describeInputTokens: description.inputTokens } : {}),
    ...(description.outputTokens !== undefined ? { describeOutputTokens: description.outputTokens } : {}),
    ...(description.ms !== undefined ? { describeMs: description.ms } : {}),
    ...(description.sentPixels ? { sentPixels: description.sentPixels } : {}),
    ...(description.sentTokens !== undefined ? { sentTokens: description.sentTokens } : {}),
    ...(takenAt ? { takenAt } : {})
  }
}

interface DescribeOutcome {
  text: string
  outcome: ImageTextResult['described']
  model?: string
  inputTokens?: number
  outputTokens?: number
  ms?: number
  sentPixels?: string
  sentTokens?: number
  takenAt?: string
}

async function describeOnce (
  db: Pool,
  bytes: Buffer,
  file: { path: string },
  contentHash: string,
  options: ImageTextOptions
): Promise<DescribeOutcome> {
  // The same picture is never described twice, whatever it is called or
  // wherever it is uploaded.
  const cached = await readDescription(db, contentHash)
  if (cached) {
    return { text: cached.text, outcome: 'cached', model: cached.model }
  }

  if (options.describer.id === 'off') { return { text: '', outcome: 'off' } }
  if (isExcluded(file.path, options.excludeFolders)) { return { text: '', outcome: 'excluded' } }
  if (await describedToday(db) >= options.dailyLimit) { return { text: '', outcome: 'over-limit' } }

  // Nothing is sent as it arrived: this strips EXIF, XMP and the colour
  // profile — a photograph's GPS position with them — and resizes the
  // image to what the API recommends.
  const prepared = await prepareImage(bytes)
  if (!prepared.ok) { return { text: '', outcome: 'unreadable' } }

  const description = await options.describer.describe(prepared.image)
  if (!description) {
    return {
      text: '',
      outcome: 'empty',
      sentPixels: `${prepared.image.width}x${prepared.image.height}`,
      sentTokens: prepared.image.tokens,
      ...(prepared.image.takenAt ? { takenAt: prepared.image.takenAt } : {})
    }
  }

  await saveDescription(db, contentHash, {
    text: description.text,
    model: description.model,
    inputTokens: description.inputTokens,
    outputTokens: description.outputTokens
  })

  return {
    text: description.text,
    outcome: 'fresh',
    model: description.model,
    inputTokens: description.inputTokens,
    outputTokens: description.outputTokens,
    ms: description.ms,
    sentPixels: `${prepared.image.width}x${prepared.image.height}`,
    sentTokens: prepared.image.tokens,
    ...(prepared.image.takenAt ? { takenAt: prepared.image.takenAt } : {})
  }
}

/** A folder is excluded along with everything under it. */
export function isExcluded (path: string, folders: readonly string[]): boolean {
  const clean = path.replace(/^\/+/, '').toLowerCase()
  return folders.some(folder => clean === folder || clean.startsWith(`${folder}/`))
}
