import { gfm } from '@joplin/turndown-plugin-gfm'
import TurndownService from 'turndown'

/**
 * Wiki.js renders every page to HTML, whatever it was written in, so the
 * agent reads one format. Tables matter — troubleshooting pages keep error
 * codes in them — hence the GFM plugin.
 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*'
})
turndown.use(gfm)

// Wiki.js puts a ¶ anchor in every heading; it is noise in an answer.
turndown.addRule('tocAnchor', {
  filter: node => node.nodeName === 'A' &&
    String((node as { className?: unknown }).className ?? '').split(/\s+/).includes('toc-anchor'),
  replacement: () => ''
})

export function htmlToMarkdown (html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim()
}

/** Keep a long page from crowding out everything else in the context. */
export function trimForContext (text: string, maxChars: number): { text: string, truncated: boolean } {
  if (text.length <= maxChars) { return { text, truncated: false } }
  const cut = text.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n\n')
  const body = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut
  return { text: `${body}\n\n…(the rest of this page was left out)`, truncated: true }
}
