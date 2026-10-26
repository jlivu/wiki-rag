/**
 * What is on the screen, and when.
 *
 * A screen recording or a slide deck carries most of its meaning in
 * writing rather than in speech, so frames are taken at every scene
 * change and at least every half minute, and Tesseract reads each one —
 * locally, for nothing, exactly as it reads an uploaded screenshot.
 *
 * A slide that stays up for two minutes would otherwise be read four
 * times, so each frame keeps only the lines the one before it did not
 * already have. The whole text is kept alongside, so a chunk that has
 * nothing new of its own can still say what was on screen during it.
 *
 * A description written by a vision model is off for videos by default:
 * a recording can be hundreds of frames, and that is a cloud bill rather
 * than a local one. Switched on, it obeys every rule images obey — the
 * excluded folders, the day's allowance, the cache by content hash — and
 * a cap on frames per video on top.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Pool } from 'pg'

import type { ImageDescriber } from '../images/describe.js'
import { ocrImage } from '../images/ocr.js'
import { prepareImage } from '../images/prepare.js'
import { describedToday, readDescription, saveDescription } from '../index-db/store.js'
import { isExcluded } from '../indexer/image-job.js'

import { extractFrames, type FrameOptions } from './ffmpeg.js'

export interface ScreenFrame {
  /** Seconds from the start of the video. */
  at: number
  /** The lines the frame before this one did not already show. */
  text: string
  /** Everything read in this frame, repeated lines and all. */
  fullText: string
  /** A description, when they are switched on and this frame got one. */
  description?: string
}

export interface FrameReadOptions extends FrameOptions {
  /** Where the video sits in the media folder, for the exclude list. */
  mediaPath: string
  ocr: boolean
  describe: boolean
  describer: ImageDescriber
  excludeFolders: readonly string[]
  dailyLimit: number
  /** At most this many frames of one video are described. */
  describeCap: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface FrameReadResult {
  frames: ScreenFrame[]
  /** How many frames were taken, before any were dropped as repeats. */
  taken: number
  ocrChars: number
  /** Frames that ended up with a description, cached ones included. */
  described: number
  /** Of those, the ones that were actually sent to a model and paid for. */
  describedFresh: number
  /** Content hashes of the described frames, so the index can keep them. */
  describedHashes: string[]
  describeInputTokens: number
  describeOutputTokens: number
  ms: number
}

export async function readScreenText (
  file: string,
  options: FrameReadOptions,
  db: Pool
): Promise<FrameReadResult> {
  const startedAt = Date.now()
  const directory = await mkdtemp(join(tmpdir(), 'wiki-frames-'))
  const frames: ScreenFrame[] = []
  let ocrChars = 0
  let described = 0
  let describedFresh = 0
  const describedHashes: string[] = []
  let describeInputTokens = 0
  let describeOutputTokens = 0

  try {
    const taken = await extractFrames(file, directory, options)
    const toDescribe = options.describe ? pickForDescription(taken.length, options.describeCap) : new Set<number>()

    let previous: string[] = []
    for (const [at, frame] of taken.entries()) {
      options.signal?.throwIfAborted()
      const bytes = await readFile(frame.file)

      let text = ''
      if (options.ocr) {
        const read = await ocrImage(bytes, '.jpg')
        text = read.text
        ocrChars += text.length
      }

      const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
      const fresh = lines.filter(line => !previous.includes(line))
      previous = lines

      let description: string | undefined
      if (toDescribe.has(at)) {
        const wrote = await describeFrame(db, bytes, options)
        if (wrote) {
          description = wrote.text
          described += 1
          describedHashes.push(wrote.contentHash)
          if (!wrote.cached) { describedFresh += 1 }
          describeInputTokens += wrote.inputTokens
          describeOutputTokens += wrote.outputTokens
        }
      }

      if (fresh.length > 0 || description) {
        frames.push({
          at: frame.at,
          text: fresh.join('\n'),
          fullText: lines.join('\n'),
          ...(description ? { description } : {})
        })
      } else if (lines.length > 0) {
        // Nothing new, but still worth knowing what was up.
        frames.push({ at: frame.at, text: '', fullText: lines.join('\n') })
      }

      await rm(frame.file, { force: true })
      options.onProgress?.(at + 1, taken.length)
    }

    return {
      frames,
      taken: taken.length,
      ocrChars,
      described,
      describedFresh,
      describedHashes,
      describeInputTokens,
      describeOutputTokens,
      ms: Date.now() - startedAt
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Which frames to describe: spread evenly across the ones we took, so a
 * cap of six on a one-hour recording still samples the whole hour.
 */
export function pickForDescription (total: number, cap: number): Set<number> {
  if (total <= 0 || cap <= 0) { return new Set() }
  if (total <= cap) { return new Set(Array.from({ length: total }, (_, at) => at)) }
  const picked = new Set<number>()
  for (let step = 0; step < cap; step++) {
    picked.add(Math.round((step * (total - 1)) / (cap - 1 || 1)))
  }
  return picked
}

interface FrameDescription {
  text: string
  /** The frame's own bytes, which the description is keyed by. */
  contentHash: string
  /** True when it came out of the cache rather than off a model. */
  cached: boolean
  inputTokens: number
  outputTokens: number
}

/**
 * One frame described, under every rule an uploaded image is described
 * under. The cache is keyed by the frame's own bytes, so re-indexing a
 * video that has not changed costs nothing: ffmpeg produces the same
 * frame from the same input.
 */
async function describeFrame (
  db: Pool,
  bytes: Buffer,
  options: FrameReadOptions
): Promise<FrameDescription | null> {
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  // Keyed by the frame's bytes, as an image's is: the same picture is
  // never paid for twice, whichever recording it turns up in. The cache
  // is read before the exclude list because nothing is *sent* here — the
  // text already exists, bought by whatever first described it.
  const cached = await readDescription(db, contentHash)
  if (cached) {
    return { text: cached.text, contentHash, cached: true, inputTokens: 0, outputTokens: 0 }
  }

  if (options.describer.id === 'off') { return null }
  if (isExcluded(options.mediaPath, options.excludeFolders)) { return null }
  if (await describedToday(db) >= options.dailyLimit) { return null }

  // Re-encoded and resized before it goes anywhere, the same as an
  // uploaded image: nothing from the recording travels with it.
  const prepared = await prepareImage(bytes)
  if (!prepared.ok) { return null }

  const description = await options.describer.describe(prepared.image)
  if (!description) { return null }

  await saveDescription(db, contentHash, {
    text: description.text,
    model: description.model,
    inputTokens: description.inputTokens,
    outputTokens: description.outputTokens
  })
  return {
    text: description.text,
    contentHash,
    cached: false,
    inputTokens: description.inputTokens,
    outputTokens: description.outputTokens
  }
}
