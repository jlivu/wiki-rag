/**
 * Plain text and Markdown.
 *
 * Markdown is cut at its headings, like a wiki page; plain text is one
 * section. Wiki.js serves .md, .html and .txt URLs as pages, so an upload
 * with one of those extensions cannot be fetched or permission-checked and
 * is skipped before it reaches here — see kind.ts.
 */
import { splitAtHeadings } from './docx.js'
import type { Extraction } from './types.js'

export function extractPlainText (bytes: Buffer, markdown: boolean): Extraction {
  const text = bytes.toString('utf8').replace(/^﻿/, '').trim()
  if (text.length === 0) { return { sections: [] } }
  if (markdown) {
    const sections = splitAtHeadings(text)
    if (sections.length > 0) { return { sections } }
  }
  return { sections: [{ label: '', anchor: '', text }] }
}
