/**
 * Section anchors come from Wiki.js, not from rules repeated here.
 *
 * Wiki.js slugs headings its own way — a heading starting with a digit gets
 * an `h-` prefix, for one — so working the anchors out again here would
 * drift the first time those rules changed.
 *
 * They are read from the rendered page's heading ids. That is the same data
 * as the page's `toc` field, from the same place: Wiki.js builds the toc by
 * walking exactly these `.toc-header` elements
 * (server/models/pages.js). The `toc` field itself cannot be fetched over
 * GraphQL — Wiki.js declares it `String` but resolves it to an array, so
 * selecting it fails with "String cannot represent value" — hence the
 * headings rather than the field.
 */

export interface TocEntry {
  title: string
  /** Includes the leading '#', e.g. "#h-1-copy-the-backup". */
  anchor: string
  depth: number
}

/** `<h2 id="scope" class="toc-header">…</h2>`, in document order. */
const HEADING = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
const ID_ATTR = /\bid="([^"]*)"/i
/** The ¶ permalink Wiki.js puts inside every heading. */
const TOC_ANCHOR_LINK = /<a\b[^>]*class="[^"]*\btoc-anchor\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi

export function tocFromRender (html: string): TocEntry[] {
  if (typeof html !== 'string' || html.length === 0) { return [] }

  const entries: TocEntry[] = []
  let match = HEADING.exec(html)
  while (match !== null) {
    const depth = Number(match[1])
    const id = ID_ATTR.exec(match[2] ?? '')?.[1] ?? ''
    const title = plainText(match[3] ?? '')
    if (title.length > 0) {
      entries.push({ title, anchor: id.length > 0 ? `#${id}` : '', depth })
    }
    match = HEADING.exec(html)
  }
  HEADING.lastIndex = 0
  return entries
}

function plainText (inner: string): string {
  return inner
    .replace(TOC_ANCHOR_LINK, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Matches the headings found while chunking against the page's own.
 *
 * Both lists are in document order, but one comes from the Markdown source
 * and the other from the rendered HTML, so they can differ by an entry.
 * Walking forward from a cursor and matching on the title tolerates that: a
 * heading with no match gets no anchor rather than borrowing the next one's.
 */
export class AnchorMatcher {
  readonly #entries: TocEntry[]
  #cursor = 0

  constructor (entries: TocEntry[]) {
    this.#entries = entries
  }

  /** The anchor for the next heading with this title, or ''. */
  take (title: string): string {
    const wanted = normalise(title)
    if (wanted.length === 0) { return '' }
    for (let at = this.#cursor; at < this.#entries.length; at++) {
      const entry = this.#entries[at]
      if (entry && normalise(entry.title) === wanted) {
        this.#cursor = at + 1
        return entry.anchor
      }
    }
    return ''
  }
}

function normalise (title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}
