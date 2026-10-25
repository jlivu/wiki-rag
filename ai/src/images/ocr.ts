/**
 * Reading the text in a picture, with Tesseract.
 *
 * Tesseract and poppler are installed in the service's image (see
 * ai/Dockerfile). Both are run directly rather than through a wasm port:
 * the binary is faster, and the image already carries it.
 *
 * Everything runs on a file we wrote ourselves in a temporary directory.
 * Tesseract's `stdin` mode looks convenient but is not safe on bytes we
 * did not produce: handed something it cannot decode, it falls back to
 * reading stdin as a *list of file paths* and OCRs those instead.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A page of a scan takes a second or two; a long one is cut off here. */
export const MAX_OCR_PAGES = 50
/** 150 dpi reads as well as 300 on ordinary print and renders twice as fast. */
const PDF_RENDER_DPI = 150
const OCR_TIMEOUT_MS = 60_000

/**
 * The flags, in the order they have to be in.
 *
 * Anything that looks like a flag *after* a config-file name is silently
 * ignored by Tesseract, so `-c debug_file=...` goes last. `--oem 1` is the
 * only engine Debian's English data supports, `--psm 3` reads screenshots
 * and photographs better than any of the alternatives, and `--dpi 300`
 * stops it guessing — and printing its guess — on an image with no
 * resolution of its own.
 */
const TESSERACT_FLAGS = [
  '-l', 'eng',
  '--oem', '1',
  '--psm', '3',
  '--dpi', '300',
  '-c', 'debug_file=/dev/null'
]

export interface OcrResult {
  text: string
  ms: number
}

/** The text in one image. Empty when there is none to find. */
export async function ocrImage (bytes: Buffer, extension = '.png'): Promise<OcrResult> {
  const startedAt = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'wiki-ocr-'))
  try {
    const file = join(dir, `image${extension}`)
    await writeFile(file, bytes)
    const { stdout } = await run('tesseract', [file, 'stdout', ...TESSERACT_FLAGS], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    })
    return { text: tidy(stdout), ms: Date.now() - startedAt }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface OcrPage {
  page: number
  text: string
}

export interface PdfOcrResult {
  pages: OcrPage[]
  /** True when the PDF has more pages than MAX_OCR_PAGES. */
  truncated: boolean
  totalPages: number
  ms: number
}

/**
 * A scanned PDF, page by page: each page is rendered to a PNG and read, so
 * a citation can still say which page it came from.
 */
export async function ocrPdf (bytes: Buffer): Promise<PdfOcrResult> {
  const startedAt = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'wiki-ocr-pdf-'))
  try {
    const file = join(dir, 'scan.pdf')
    await writeFile(file, bytes)

    const totalPages = await pdfPageCount(file)
    const limit = Math.min(totalPages, MAX_OCR_PAGES)
    const pages: OcrPage[] = []

    for (let page = 1; page <= limit; page++) {
      const png = await renderPdfPage(file, page, dir)
      if (!png) { continue }
      const { text } = await ocrImage(png, '.png')
      if (text.length > 0) { pages.push({ page, text }) }
    }

    return { pages, truncated: totalPages > limit, totalPages, ms: Date.now() - startedAt }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function pdfPageCount (file: string): Promise<number> {
  try {
    const { stdout } = await run('pdfinfo', [file], { timeout: OCR_TIMEOUT_MS })
    const match = /^Pages:\s+(\d+)/m.exec(stdout)
    return match?.[1] ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

/**
 * One page as a PNG. `-singlefile` matters: without it a range is written
 * as several PNG streams run together, and only the first is ever read.
 */
async function renderPdfPage (file: string, page: number, dir: string): Promise<Buffer | null> {
  const prefix = join(dir, `page-${page}`)
  try {
    // -q because pdftoppm reports a rebuilt xref on stderr while rendering
    // the page perfectly well.
    await run('pdftoppm', [
      '-q', '-png', '-r', String(PDF_RENDER_DPI),
      '-f', String(page), '-l', String(page), '-singlefile',
      file, prefix
    ], { timeout: OCR_TIMEOUT_MS })
    return await readFile(`${prefix}.png`)
  } catch {
    return null
  }
}

/** OCR output is ragged: drop empty lines and the usual stray marks. */
function tidy (text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.trim().length > 0)
    .join('\n')
    .trim()
}
