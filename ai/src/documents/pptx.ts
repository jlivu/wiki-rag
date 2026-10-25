/**
 * PowerPoint, a section per slide.
 *
 * There is no library worth taking for this: the published ones are built
 * for rendering in a browser, or are abandoned, or number the slides by
 * file name — which is not the order they are shown in. A .pptx is a zip of
 * XML, so it is read here directly, in the order ppt/presentation.xml gives.
 */
import { XMLParser } from 'fast-xml-parser'
import { strFromU8, unzipSync } from 'fflate'

import { ExtractionError, type DocSection, type Extraction } from './types.js'

// preserveOrder keeps runs, breaks and fields in the order they appear
// inside a paragraph; without it the text of a slide comes out scrambled.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false
})

type Node = Record<string, unknown>

export function extractPptx (bytes: Buffer): Extraction {
  let zip: Record<string, Uint8Array>
  try {
    zip = unzipSync(new Uint8Array(bytes))
  } catch {
    throw new ExtractionError('the presentation could not be opened')
  }

  const read = (name: string): string | undefined => {
    const file = zip[name]
    return file ? strFromU8(file) : undefined
  }

  const presentation = read('ppt/presentation.xml')
  if (!presentation) {
    throw new ExtractionError('the presentation has no ppt/presentation.xml')
  }

  // Slides are shown in the order of p:sldIdLst, which points at the
  // relationships file — not in the order of the slideN.xml file names.
  const rels = new Map<string, string>()
  for (const rel of findAll(parser.parse(read('ppt/_rels/presentation.xml.rels') ?? ''), 'Relationship')) {
    const attrs = attrsOf(rel)
    const id = attrs['@_Id']
    if (id) { rels.set(id, `ppt/${String(attrs['@_Target'] ?? '').replace(/^\/?(ppt\/)?/, '')}`) }
  }

  const sections: DocSection[] = []
  const slideIds = findAll(parser.parse(presentation), 'p:sldId')
  slideIds.forEach((slideId, at) => {
    const part = rels.get(attrsOf(slideId)['@_r:id'] ?? '')
    const body = part ? read(part) : undefined
    if (!body) { return }
    const tree = parser.parse(body)

    let title: string | undefined
    const blocks: string[] = []

    for (const shape of findAll(tree, 'p:sp')) {
      const text = shapeText(shape)
      if (text.length === 0) { continue }
      if (title === undefined && isTitle(shape)) { title = text } else { blocks.push(text) }
    }
    // A deck with no placeholders at all: the first block is the heading.
    const titleFromBlock = title === undefined && blocks.length > 0

    // A table is not a shape: it hangs off a graphic frame.
    for (const frame of findAll(tree, 'p:graphicFrame')) {
      for (const row of findAll(kidsOf(frame), 'a:tr')) {
        const cells = findAll(kidsOf(row), 'a:tc')
          .map(cell => findAll(kidsOf(cell), 'a:p').map(paragraphText).join(' ').trim())
        if (cells.some(cell => cell.length > 0)) { blocks.push(cells.join(' · ')) }
      }
    }

    // Not every deck has a title placeholder; plenty use a plain text box.
    if (titleFromBlock) { title = (blocks.shift() ?? '').split('\n')[0] }
    // The title is already in the label, which every chunk is prefixed
    // with, so it is not repeated in the body.
    const text = blocks.join('\n\n').trim() || (title ?? '')
    if (text.length === 0) { return }

    const number = at + 1
    sections.push({
      label: title ? `Slide ${number} "${clip(title)}"` : `Slide ${number}`,
      anchor: '',
      text
    })
  })

  return { sections }
}

function clip (title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim()
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean
}

/* ── walking a preserveOrder tree ──────────────────────────────────── */

/** Every node is `{ '<tag>': children[], ':@'?: attributes }`. */
function tagOf (node: Node): string {
  return Object.keys(node).find(key => key !== ':@') ?? ''
}

function kidsOf (node: Node): Node[] {
  const value = node[tagOf(node)]
  return Array.isArray(value) ? value as Node[] : []
}

function attrsOf (node: Node): Record<string, string> {
  return (node[':@'] as Record<string, string> | undefined) ?? {}
}

function findAll (nodes: Node[], tag: string, found: Node[] = []): Node[] {
  for (const node of nodes) {
    if (tagOf(node) === tag) { found.push(node) }
    findAll(kidsOf(node), tag, found)
  }
  return found
}

function paragraphText (paragraph: Node): string {
  let text = ''
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      const tag = tagOf(node)
      if (tag === 'a:br') { text += '\n'; continue }
      // The automatic slide number would arrive as a stray digit.
      if (tag === 'a:fld' && attrsOf(node)['@_type'] === 'slidenum') { continue }
      if (tag === 'a:t') {
        text += kidsOf(node).map(child => String((child as { '#text'?: unknown })['#text'] ?? '')).join('')
        continue
      }
      walk(kidsOf(node))
    }
  }
  walk(kidsOf(paragraph))
  return text
}

function shapeText (shape: Node): string {
  return findAll(kidsOf(shape), 'a:p')
    .map(paragraph => paragraphText(paragraph).trim())
    .filter(line => line.length > 0)
    .join('\n')
}

function isTitle (shape: Node): boolean {
  return findAll(kidsOf(shape), 'p:ph')
    .some(placeholder => ['title', 'ctrTitle'].includes(attrsOf(placeholder)['@_type'] ?? ''))
}
