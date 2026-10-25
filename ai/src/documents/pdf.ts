/**
 * PDF, a section per page.
 *
 * unpdf bundles its own pdf.js build for servers: no worker to wire up, no
 * canvas, no DOM. Only text is ever read — renderPageAsImage is the one API
 * that would pull a native dependency, and nothing here calls it.
 */
import { extractText, getDocumentProxy } from 'unpdf'

import { ExtractionError, type Extraction } from './types.js'

export async function extractPdf (bytes: Buffer): Promise<Extraction> {
  let text: string[]
  try {
    // pdf.js transfers the array it is handed to its worker and leaves the
    // original detached, so it gets a copy of its own.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
    const extracted = await extractText(pdf, { mergePages: false })
    text = extracted.text
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'PasswordException') {
      throw new ExtractionError('the PDF is password protected')
    }
    throw new ExtractionError(`the PDF could not be read (${name || 'unknown error'})`)
  }

  const pages = text.map((page, at) => ({ number: at + 1, text: page.trim() }))

  // Every page empty means there is no text layer at all — a scan.
  if (pages.every(page => page.text.length === 0)) {
    return { sections: [], needsOcr: true }
  }

  return {
    sections: pages
      .filter(page => page.text.length > 0)
      .map(page => ({
        label: `Page ${page.number}`,
        // Browsers and the built-in PDF viewers honour #page=N.
        anchor: `#page=${page.number}`,
        text: page.text
      }))
  }
}
