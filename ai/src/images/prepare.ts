/**
 * Getting an image ready to be looked at.
 *
 * Nothing leaves this machine as it arrived. Every image is decoded,
 * re-encoded and resized here first, which strips EXIF, XMP, IPTC and the
 * colour profile with it — so a photograph's GPS position cannot reach a
 * model even by accident. The capture date is read before that happens,
 * because the date is worth indexing and the position never is.
 */
import exifr from 'exifr'
import { fileTypeFromBuffer } from 'file-type'
import type { FileTypeResult } from 'file-type'
import sharp from 'sharp'
import type { Metadata, Sharp } from 'sharp'

/**
 * Anthropic's vision tiers. Each sets two limits — a long edge *and* a
 * number of visual tokens — and for an ordinary 4:3 photograph the token
 * limit is the one that bites: 4032×3024 capped to 1568px on the long edge
 * is 2352 tokens, half as many again as the tier allows, and the API would
 * quietly shrink it a second time. Fitting both is cheaper and sharper.
 *
 * https://docs.claude.com/en/docs/build-with-claude/vision
 */
const TIERS = {
  standard: { longEdge: 1568, maxTokens: 1568 },
  highres: { longEdge: 2576, maxTokens: 4784 }
} as const

export type Tier = keyof typeof TIERS

/** Claude bills an image in 28×28 patches. */
export function visualTokens (width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28)
}

/** The largest size inside both of a tier's limits. Never enlarges. */
export function fitToTier (width: number, height: number, tier: Tier = 'standard'): {
  width: number
  height: number
} {
  const { longEdge, maxTokens } = TIERS[tier]
  let scale = Math.min(
    1,
    longEdge / Math.max(width, height),
    Math.sqrt((maxTokens * 28 * 28) / (width * height))
  )
  let w = Math.max(1, Math.round(width * scale))
  let h = Math.max(1, Math.round(height * scale))
  // Rounding up to whole patches can push one patch over the budget.
  while (visualTokens(w, h) > maxTokens && (w > 1 || h > 1)) {
    scale *= 0.995
    w = Math.max(1, Math.round(width * scale))
    h = Math.max(1, Math.round(height * scale))
  }
  return { width: w, height: h }
}

/**
 * HEIC arrives under four MIME names depending on the brand in its header,
 * and the bundled libvips cannot decode any of them: its "heif" support is
 * AVIF only. Letting sharp throw would report the wrong reason.
 */
const HEIC_MIMES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])
/** What we index, and what the vision API accepts. */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

export type PreparedImage = {
  mediaType: 'image/jpeg'
  data: Buffer
  width: number
  height: number
  bytes: number
  /** What this image will cost to look at. */
  tokens: number
  sourceMime: string
  /** EXIF DateTimeOriginal, if the camera recorded one. Never a position. */
  takenAt?: string
}

export type PrepareResult =
  | { ok: true, image: PreparedImage }
  | { ok: false, reason: string }

export function isImageMime (mime: string): boolean {
  return IMAGE_MIMES.has(mime) || HEIC_MIMES.has(mime)
}

/** What the bytes really are, whatever the file is called. */
export async function sniffImage (bytes: Buffer): Promise<FileTypeResult | undefined> {
  return fileTypeFromBuffer(bytes)
}

export async function prepareImage (bytes: Buffer, tier: Tier = 'standard'): Promise<PrepareResult> {
  const sniffed = await sniffImage(bytes)
  if (!sniffed) { return { ok: false, reason: 'the file is not an image we recognise' } }
  if (HEIC_MIMES.has(sniffed.mime)) {
    return { ok: false, reason: 'a HEIC image; convert it to JPEG to index it' }
  }
  if (!IMAGE_MIMES.has(sniffed.mime)) {
    return { ok: false, reason: `an unsupported image format (${sniffed.mime})` }
  }

  // Read the date before the metadata is thrown away.
  const takenAt = await readTakenAt(bytes)

  // animated: false takes the first frame, which is what an animated GIF
  // gets us and all the vision API would use anyway.
  const pipeline: Sharp = sharp(bytes, { animated: false, failOn: 'error' })
  let meta: Metadata
  try {
    meta = await pipeline.metadata()
  } catch (err) {
    return { ok: false, reason: `the image could not be read (${err instanceof Error ? err.message : 'unknown error'})` }
  }

  const sourceWidth = meta.width ?? 0
  const sourceHeight = meta.height ?? 0
  if (sourceWidth === 0 || sourceHeight === 0) {
    return { ok: false, reason: 'the image has no readable size' }
  }

  const target = fitToTier(sourceWidth, sourceHeight, tier)

  try {
    const out = await pipeline
      // Bake in the EXIF orientation first: stripping the metadata throws
      // the orientation tag away, and a sideways photograph cannot be put
      // right again afterwards.
      .rotate()
      .resize({ ...target, fit: 'inside', withoutEnlargement: true })
      // No keepMetadata, no withMetadata, no keepExif: sharp's default is
      // to write none of it, and that is the point of this module.
      .jpeg({ quality: 82, chromaSubsampling: '4:2:0', mozjpeg: true })
      .toBuffer({ resolveWithObject: true })

    return {
      ok: true,
      image: {
        mediaType: 'image/jpeg',
        data: out.data,
        width: out.info.width,
        height: out.info.height,
        bytes: out.data.length,
        tokens: visualTokens(out.info.width, out.info.height),
        sourceMime: sniffed.mime,
        ...(takenAt ? { takenAt } : {})
      }
    }
  } catch (err) {
    return { ok: false, reason: `the image could not be converted (${err instanceof Error ? err.message : 'unknown error'})` }
  }
}

/**
 * The capture date, and nothing else.
 *
 * `pick` at the top level is the only form that does what it says. A
 * per-segment filter — `{ exif: ['DateTimeOriginal'] }` — still returns
 * GPSLatitude and GPSLongitude alongside the date, and combining `pick`
 * with `tiff: true` re-enables every segment. Both were tried.
 */
export async function readTakenAt (bytes: Buffer): Promise<string | undefined> {
  try {
    const parsed = await exifr.parse(bytes, { pick: ['DateTimeOriginal'] }) as
      { DateTimeOriginal?: unknown } | undefined
    const value = parsed?.DateTimeOriginal
    if (value instanceof Date && !Number.isNaN(value.getTime())) { return value.toISOString() }
    if (typeof value === 'string') {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) { return date.toISOString() }
    }
  } catch {
    // An image with no EXIF, or EXIF we cannot read, simply has no date.
  }
  return undefined
}
