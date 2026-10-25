/**
 * What a file is, and whether it can be indexed at all.
 *
 * Every answer is recorded against the document, so an administrator can
 * see why a file is not searchable without reading the log.
 */
import type { DocumentMeta } from './types.js'

export type DocType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'text' | 'markdown' | 'image'

export type Classification =
  | { index: true, docType: DocType }
  | { index: false, reason: string }

const BY_EXTENSION: Record<string, DocType> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.csv': 'csv',
  '.txt': 'text',
  '.md': 'markdown',
  '.markdown': 'markdown'
}

/**
 * Pictures we cannot read. HEIC needs a codec the bundled libvips does not
 * carry; the rest are either vector art or formats no vision model takes.
 * Anything not listed here and matched in BY_EXTENSION is indexed.
 */
const UNREADABLE_IMAGES: Record<string, string> = {
  '.heic': 'a HEIC image; convert it to JPEG to index it',
  '.heif': 'a HEIF image; convert it to JPEG to index it',
  '.svg': 'an SVG drawing, which has no pixels to read',
  '.bmp': 'a BMP image; convert it to PNG or JPEG to index it',
  '.tif': 'a TIFF image; convert it to PNG or JPEG to index it',
  '.tiff': 'a TIFF image; convert it to PNG or JPEG to index it',
  '.ico': 'an icon',
  '.avif': 'an AVIF image; convert it to JPEG to index it'
}

/** Saved by a version of Office old enough that the file is not a zip. */
const LEGACY: Record<string, string> = {
  '.doc': 'a legacy .doc file; save it as .docx to index it',
  '.xls': 'a legacy .xls file; save it as .xlsx to index it',
  '.ppt': 'a legacy .ppt file; save it as .pptx to index it'
}

export interface ClassifyInput extends DocumentMeta {
  /** Wiki.js's own split: image or binary. */
  assetKind: string
  fileSize: number
  maxBytes: number
  /**
   * Extensions Wiki.js serves as pages rather than as files. A file with
   * one of these cannot be downloaded or permission-checked at its own URL,
   * so it is left out rather than indexed and hidden from no one.
   */
  pageExtensions: readonly string[]
}

export function classify (input: ClassifyInput): Classification {
  const ext = input.ext.toLowerCase()

  const unreadable = UNREADABLE_IMAGES[ext]
  if (unreadable) { return { index: false, reason: unreadable } }

  const legacy = LEGACY[ext]
  if (legacy) { return { index: false, reason: legacy } }

  const docType = BY_EXTENSION[ext]
  if (!docType) {
    // Wiki.js calls anything it recognises as a picture an "image"; if we
    // got here the extension is one we cannot read.
    const kind = input.assetKind.toLowerCase() === 'image' || input.mime.startsWith('image/')
      ? 'an image in a format we cannot read'
      : `an unsupported file type (${ext || input.mime || 'unknown'})`
    return { index: false, reason: kind }
  }

  if (input.pageExtensions.includes(ext.replace(/^\./, ''))) {
    return {
      index: false,
      // Wiki.js's catch-all route sends anything ending in a page extension
      // to the page branch, so the file 404s at its own URL.
      reason: `Wiki.js serves ${ext} URLs as pages, so this file cannot be fetched or permission-checked`
    }
  }

  const folder = unreachableFolder(input.path)
  if (folder) {
    return {
      index: false,
      // pageHelper.parsePath drops a leading segment that looks like a
      // locale, so /it/manual.pdf is looked up as manual.pdf: the file
      // 404s, or — worse — a different file of that name at the root is
      // served in its place, under the wrong permissions.
      reason: `in a folder named "${folder}", which Wiki.js reads as a locale, so the file cannot be fetched at its own URL`
    }
  }

  if (input.fileSize > input.maxBytes) {
    return {
      index: false,
      reason: `larger than the ${mb(input.maxBytes)} MB limit (${mb(input.fileSize)} MB)`
    }
  }

  return { index: true, docType }
}

/** The first folder, when Wiki.js would strip it from the file's URL. */
function unreachableFolder (path: string): string | null {
  const parts = path.replace(/^\/+/, '').split('/')
  if (parts.length < 2) { return null }
  const first = parts[0] ?? ''
  // Wiki.js strips a two-letter or xx-yy segment as a locale, and a
  // one-character segment as well.
  return first.length <= 2 || /^[a-z]{2}-[a-z]{2}$/i.test(first) ? first : null
}

function mb (bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')
}
