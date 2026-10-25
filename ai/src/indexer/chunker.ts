/**
 * Splitting a page into chunks.
 *
 * Markdown is cut at its headings, because a heading marks a change of
 * subject and keeps a chunk about one thing. A section longer than the
 * target is split again at blank lines; a very short one is merged with the
 * next, so a page of one-line sections does not become a page of one-line
 * chunks.
 *
 * Every chunk is prefixed with the page title and the headings above it, so
 * a chunk read on its own still says what it is about — which is what gets
 * embedded.
 */
import { createHash } from 'node:crypto'

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
  /** Prefixed text: what is embedded and what retrieval returns. */
  text: string
  contentHash: string
  tokens: number
}

export function estimateTokens (text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function chunkMarkdown (markdown: string, title: string): Chunk[] {
  const sections = splitAtHeadings(markdown)
  const pieces: Array<{ headingPath: string, body: string }> = []

  for (const section of sections) {
    for (const body of splitLongBody(section.body)) {
      pieces.push({ headingPath: section.headingPath, body })
    }
  }

  // Merge a short piece into the one after it, as long as they share a
  // heading and the result still fits.
  const merged: Array<{ headingPath: string, body: string }> = []
  for (const piece of pieces) {
    const previous = merged[merged.length - 1]
    if (
      previous &&
      previous.body.length < MIN_CHARS &&
      previous.body.length + piece.body.length <= MAX_CHARS
    ) {
      previous.body = `${previous.body}\n\n${piece.body}`.trim()
      if (previous.headingPath !== piece.headingPath && piece.headingPath.length > 0) {
        previous.headingPath = previous.headingPath.length > 0 ? previous.headingPath : piece.headingPath
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
  body: string
}

/** Walk the lines, tracking fenced code so a `#` in a snippet is not a heading. */
function splitAtHeadings (markdown: string): Section[] {
  const sections: Section[] = []
  const stack: string[] = []
  let body: string[] = []
  let fence: string | null = null

  const flush = () => {
    const text = body.join('\n').trim()
    if (text.length > 0) {
      sections.push({ headingPath: stack.filter(Boolean).join(' › '), body: text })
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
      stack[level - 1] = heading[2].trim()
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
