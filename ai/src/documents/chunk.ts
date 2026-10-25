/**
 * Cutting a document into chunks.
 *
 * The rules are the page chunker's: roughly 300–600 tokens, never crossing
 * from one place in the file into another, and every chunk prefixed with
 * where it came from so it still says what it is when read on its own.
 *
 * What differs is what "a place" means. A page of a PDF, a heading in a
 * Word file and a slide are sections of prose, split at blank lines when
 * they are long. A sheet is rows: they are split by row, the header is
 * repeated at the top of every chunk, and each chunk says which rows it
 * holds — "Sheet "Budget" rows 12–40".
 */
import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS, estimateTokens, hash } from '../indexer/chunker.js'

import type { DocSection } from './types.js'

export interface DocChunk {
  ordinal: number
  /** The section this came from, for the chunk's own prefix. */
  headingPath: string
  /** What a citation shows: "Page 4", "Sheet \"Budget\" rows 12–40". */
  location: string
  /** "#page=4", or '' when the format has nowhere to jump to. */
  anchor: string
  text: string
  contentHash: string
  tokens: number
}

export function chunkDocument (fileName: string, sections: DocSection[]): DocChunk[] {
  const chunks: DocChunk[] = []

  for (const section of sections) {
    const pieces = section.firstRow === undefined
      ? splitProse(section.text).map(text => ({ text, location: section.label }))
      : splitRows(section, section.firstRow)

    for (const piece of pieces) {
      const body = section.header && section.firstRow !== undefined
        ? `${section.header}\n${piece.text}`
        : piece.text
      const text = prefix(fileName, piece.location, body)
      chunks.push({
        ordinal: chunks.length,
        headingPath: section.label,
        location: piece.location,
        anchor: section.anchor,
        text,
        contentHash: hash(text),
        tokens: estimateTokens(text)
      })
    }
  }

  return chunks
}

function prefix (fileName: string, location: string, body: string): string {
  const header = [fileName.trim(), location.trim()].filter(part => part.length > 0).join(' › ')
  return header.length > 0 ? `${header}\n\n${body.trim()}` : body.trim()
}

/** Prose: cut at blank lines, then at line endings if a block is huge. */
function splitProse (text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) { return [] }
  if (trimmed.length <= CHUNK_MAX_CHARS) { return [trimmed] }

  const pieces: string[] = []
  let current = ''
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const candidate = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > CHUNK_MAX_CHARS && current.length > 0) {
      pieces.push(current)
      current = paragraph
    } else {
      current = candidate
    }
    while (current.length > CHUNK_MAX_CHARS) {
      const cut = current.lastIndexOf('\n', CHUNK_MAX_CHARS)
      const at = cut > CHUNK_MIN_CHARS ? cut : CHUNK_MAX_CHARS
      pieces.push(current.slice(0, at))
      current = current.slice(at).trimStart()
    }
  }
  if (current.trim().length > 0) { pieces.push(current) }
  return pieces.map(piece => piece.trim()).filter(piece => piece.length > 0)
}

/** Rows: whole rows only, and every chunk says which ones it holds. */
function splitRows (
  section: DocSection,
  firstRow: number
): Array<{ text: string, location: string }> {
  const lines = section.text.split('\n')
  const headerLength = section.header ? section.header.length + 1 : 0
  const out: Array<{ text: string, location: string }> = []

  let held: string[] = []
  let startRow = firstRow

  const flush = (lastRow: number) => {
    if (held.length === 0) { return }
    const rows = rowRange(startRow, lastRow)
    out.push({
      text: held.join('\n'),
      // A CSV has no sheet to name, so the rows stand on their own.
      location: section.label.length > 0
        ? `${section.label} ${rows}`
        : `${rows.charAt(0).toUpperCase()}${rows.slice(1)}`
    })
    held = []
  }

  lines.forEach((line, at) => {
    const rowNumber = firstRow + at
    const length = held.reduce((sum, row) => sum + row.length + 1, headerLength)
    if (held.length > 0 && length + line.length > CHUNK_MAX_CHARS) {
      flush(rowNumber - 1)
      startRow = rowNumber
    }
    held.push(line)
  })
  flush(firstRow + lines.length - 1)

  return out
}

function rowRange (from: number, to: number): string {
  return from === to ? `row ${from}` : `rows ${from}–${to}`
}
