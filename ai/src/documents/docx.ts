/**
 * Word, a section per heading.
 *
 * mammoth turns the document into HTML with real h1–h6 elements, which the
 * service's existing Turndown setup then turns into the same Markdown the
 * page indexer works with — so one chunker understands both.
 */
import mammoth from 'mammoth'

import { htmlToMarkdown } from '../wiki/markdown.js'

import { ExtractionError, type DocSection, type Extraction } from './types.js'

/** Word's Title and Subtitle are not headings to mammoth unless told. */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh"
]

/** An OLE2 compound file: a .doc from before the XML formats. */
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

export async function extractDocx (bytes: Buffer): Promise<Extraction> {
  if (bytes.subarray(0, 8).equals(OLE2_MAGIC)) {
    throw new ExtractionError('this is a legacy .doc file; save it as .docx to index it')
  }

  let html: string
  try {
    const result = await mammoth.convertToHtml({ buffer: bytes }, { styleMap: STYLE_MAP })
    html = result.value
  } catch (err) {
    throw new ExtractionError(`the document could not be read (${err instanceof Error ? err.message : 'unknown error'})`)
  }

  return { sections: splitAtHeadings(htmlToMarkdown(html)) }
}

/** The same cut as a wiki page: a heading starts a new section. */
export function splitAtHeadings (markdown: string): DocSection[] {
  const sections: DocSection[] = []
  let heading: string | null = null
  let lines: string[] = []

  const flush = () => {
    const text = lines.join('\n').trim()
    if (text.length === 0 && heading === null) { return }
    if (text.length === 0) { return }
    sections.push({
      label: heading === null ? 'Beginning' : `Section "${heading}"`,
      anchor: '',
      text
    })
  }

  for (const line of markdown.split('\n')) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match?.[2] !== undefined) {
      flush()
      heading = match[2].trim()
      lines = []
      continue
    }
    lines.push(line)
  }
  flush()

  return sections
}
