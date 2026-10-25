/**
 * Splitting a page into chunks.
 *
 * Markdown is cut at its headings, because a heading marks a change of
 * subject and keeps a chunk about one thing. A section longer than the
 * target is split again at blank lines, and those pieces can be merged back
 * together if they are short.
 *
 * Nothing is ever merged across a heading. A chunk links to the section it
 * came from, and a chunk that ran on past its heading would point a reader
 * at a section its text had already left.
 *
 * Every chunk is prefixed with the page title and the headings above it, so
 * a chunk read on its own still says what it is about — which is what gets
 * embedded.
 */
import { createHash } from 'node:crypto'

import { AnchorMatcher, type TocEntry } from './toc.js'

/** No tokenizer is available for an arbitrary embedding model, so this
 *  approximates one: English prose runs about four characters per token. */
const CHARS_PER_TOKEN = 4
const MIN_TOKENS = 300
const MAX_TOKENS = 600
const MIN_CHARS = MIN_TOKENS * CHARS_PER_TOKEN
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN

export interface Chunk {
  ordinal: number
  headingPath: string
  /** Wiki.js's anchor for the section this chunk opens in, e.g. "#scope". */
  anchor: string
  /** Prefixed text: what is embedded and what retrieval returns. */
  text: string
  contentHash: string
  tokens: number
}

export function estimateTokens (text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function chunkMarkdown (markdown: string, title: string, toc: TocEntry[] = []): Chunk[] {
  const sections = splitAtHeadings(markdown, new AnchorMatcher(toc))
  const pieces: Array<{ headingPath: string, anchor: string, body: string }> = []

  for (const section of sections) {
    for (const body of splitLongBody(section.body)) {
      pieces.push({ headingPath: section.headingPath, anchor: section.anchor, body })
    }
  }

  // Merge a short piece into the one after it, as long as the two are in
  // the same section and the result still fits. Text before the first
  // heading has no section of its own, so it joins the one below it.
  const merged: Array<{ headingPath: string, anchor: string, body: string }> = []
  for (const piece of pieces) {
    const previous = merged[merged.length - 1]
    const preamble = previous?.headingPath.length === 0 && previous.anchor.length === 0
    if (
      previous &&
      (preamble || previous.headingPath === piece.headingPath) &&
      previous.body.length < MIN_CHARS &&
      previous.body.length + piece.body.length <= MAX_CHARS
    ) {
      previous.body = `${previous.body}\n\n${piece.body}`.trim()
      if (preamble) {
        previous.headingPath = piece.headingPath
        previous.anchor = piece.anchor
      }
      continue
    }
    merged.push({ ...piece })
  }

  return merged
    .filter(piece => piece.body.trim().length > 0)
    .map((piece, ordinal) => {
      const headingPath = cleanHeadingPath(piece.headingPath, title)
      const text = prefix(title, headingPath, piece.body)
      return {
        ordinal,
        headingPath,
        // The section a reader lands in when they follow the link.
        anchor: piece.anchor,
        text,
        contentHash: hash(text),
        tokens: estimateTokens(text)
      }
    })
}

export function hash (value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Most pages open with an H1 that repeats the title, which would read as
 * "Home Page › Home Page › Purpose". Drop a segment that just says the
 * title again, and any that repeats the one before it.
 */
function cleanHeadingPath (headingPath: string, title: string): string {
  const wanted = title.trim().toLowerCase()
  const kept: string[] = []
  for (const segment of headingPath.split(' › ')) {
    const clean = segment.trim()
    if (clean.length === 0) { continue }
    if (clean.toLowerCase() === wanted) { continue }
    if (kept[kept.length - 1]?.toLowerCase() === clean.toLowerCase()) { continue }
    kept.push(clean)
  }
  return kept.join(' › ')
}

function prefix (title: string, headingPath: string, body: string): string {
  const header = [title.trim(), headingPath.trim()].filter(part => part.length > 0).join(' › ')
  return header.length > 0 ? `${header}\n\n${body.trim()}` : body.trim()
}

interface Section {
  headingPath: string
  anchor: string
  body: string
}

/** Walk the lines, tracking fenced code so a `#` in a snippet is not a heading. */
function splitAtHeadings (markdown: string, anchors: AnchorMatcher): Section[] {
  const sections: Section[] = []
  const stack: string[] = []
  let body: string[] = []
  let fence: string | null = null
  let anchor = ''

  const flush = () => {
    const text = body.join('\n').trim()
    if (text.length > 0) {
      sections.push({ headingPath: stack.filter(Boolean).join(' › '), anchor, body: text })
    }
    body = []
  }

  for (const line of markdown.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch?.[1]) {
      if (fence === null) {
        fence = fenceMatch[1][0] ?? '`'
      } else if (line.trimStart().startsWith(fence.repeat(3))) {
        fence = null
      }
      body.push(line)
      continue
    }

    const heading = fence === null ? /^(#{1,6})\s+(.*)$/.exec(line) : null
    if (heading?.[1] && heading[2] !== undefined) {
      flush()
      const level = heading[1].length
      stack.length = Math.min(stack.length, level - 1)
      while (stack.length < level - 1) { stack.push('') }
      const heed = heading[2].trim()
      stack[level - 1] = heed
      // Every heading is offered to the matcher, in document order, so its
      // cursor stays in step with the page.
      anchor = anchors.take(heed)
      continue
    }

    body.push(line)
  }

  flush()
  return sections
}

/** Cut an over-long section at blank lines, keeping pieces under the ceiling. */
function splitLongBody (body: string): string[] {
  if (body.length <= MAX_CHARS) { return [body] }

  const pieces: string[] = []
  let current = ''
  for (const paragraph of body.split(/\n{2,}/)) {
    const candidate = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > MAX_CHARS && current.length > 0) {
      pieces.push(current)
      current = paragraph
    } else {
      current = candidate
    }
    // A single paragraph larger than the ceiling is cut on line boundaries.
    while (current.length > MAX_CHARS) {
      const cut = current.lastIndexOf('\n', MAX_CHARS)
      const at = cut > MIN_CHARS ? cut : MAX_CHARS
      pieces.push(current.slice(0, at))
      current = current.slice(at).trimStart()
    }
  }
  if (current.trim().length > 0) { pieces.push(current) }
  return pieces
}
