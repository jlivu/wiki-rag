/**
 * What a page says about the images it shows.
 *
 * An image's own pixels are only part of what is known about it: the page
 * that shows it gives it alt text and, often, a caption underneath. Both
 * are indexed with the image, so a picture with no legible text in it can
 * still be found by what the wiki calls it.
 *
 * The rendered HTML is read with regular expressions, as everywhere else in
 * this service. Two details of Wiki.js's own output decide the shapes
 * below: `>` is not escaped inside an attribute value (`alt="a > b"` is
 * real output, so `<img[^>]*>` would stop mid-tag), and `linebreaks` is on
 * by default, so a caption written on the line under an image lands in the
 * same paragraph after a `<br>` rather than in one of its own.
 */

/** Scanners that step over quoted runs, because `>` can appear inside one. */
const imgTag = (): RegExp => /<img\b(?:[^>"]*"[^"]*")*[^>"]*>/gi
const figureBlock = (): RegExp => /<figure\b(?:[^>"]*"[^"]*")*[^>"]*>([\s\S]*?)<\/figure>/gi
const paragraph = (): RegExp => /<p\b(?:[^>"]*"[^"]*")*[^>"]*>([\s\S]*?)<\/p>/gi
const FIGCAPTION = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g

/** A paragraph that reads like a caption rather than like body text. */
const CAPTION_WORD = /^(fig(ure|\.)?|image|photo|photograph|screenshot|diagram|plate|map|chart|table)\b/i
const EMPHASISED = /^\s*<(em|i|strong|b|small)\b/i
const CAPTION_MAX_CHARS = 200
/** An alt that is only the file name says nothing; the asset browser writes one. */
const FILENAME_ALT = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i

export interface PageImage {
  /** The src exactly as the page wrote it. */
  src: string
  alt: string
  caption: string
}

export function imagesIn (html: string): PageImage[] {
  if (typeof html !== 'string' || html.length === 0) { return [] }

  const figures = spansOf(figureBlock(), html).map(span => ({
    ...span,
    caption: plain(FIGCAPTION.exec(span.inner)?.[1] ?? '')
  }))
  const paragraphs = spansOf(paragraph(), html)

  const found: PageImage[] = []
  const tags = imgTag()
  let match = tags.exec(html)

  while (match !== null) {
    const tag = match[0]
    const attrs = attributesOf(tag)
    const src = attrs.src ?? ''
    const at = match.index
    const after = at + tag.length
    match = tags.exec(html)

    if (src.length === 0 || src.startsWith('data:')) { continue }
    // PlantUML and Kroki render their diagrams as images with no alt and a
    // generated source; they are not uploaded files.
    if (/\buml-diagram\b|\bprefetch-candidate\b/.test(attrs.class ?? '')) { continue }

    found.push({
      src,
      alt: describingAlt(attrs.alt ?? '', src),
      caption: captionFor({ at, after, attrs, figures, paragraphs, html })
    })
  }

  return found
}

interface CaptionInput {
  at: number
  after: number
  attrs: Record<string, string>
  figures: Array<Span & { caption: string }>
  paragraphs: Span[]
  html: string
}

function captionFor (input: CaptionInput): string {
  // 1. The figure this image sits in, whichever side its caption is on.
  const figure = input.figures.find(span => input.at > span.start && input.at < span.end)
  if (figure && figure.caption.length > 0) { return figure.caption }

  const para = input.paragraphs.find(span => input.at > span.start && input.at < span.end)
  // Only an image that opens its own paragraph, alone, can have a caption:
  // an icon used mid-sentence would otherwise be captioned with the prose
  // around it.
  if (para && plain(para.inner.slice(0, input.at - para.innerStart)).length === 0 &&
      (para.inner.match(imgTag()) ?? []).length === 1) {
    // 2. The rest of that paragraph — the caption-on-the-next-line form.
    const rest = plain(para.inner.slice(input.after - para.innerStart))
    if (rest.length > 0) { return rest }

    // 3. The paragraph straight after, if it reads like a caption and is
    //    not itself an image.
    const next = input.paragraphs.find(span => span.start >= para.end && span.start - para.end <= 2)
    if (next && !imgTag().test(next.inner)) {
      const text = plain(next.inner)
      if (text.length > 0 && text.length <= CAPTION_MAX_CHARS &&
          (EMPHASISED.test(next.inner.trim()) || CAPTION_WORD.test(text))) {
        return text
      }
    }
  }

  // 4. The title attribute: ![alt](x "title").
  return input.attrs.title ?? ''
}

/** An alt worth indexing: not empty, and not just the file's name. */
function describingAlt (alt: string, src: string): string {
  const clean = alt.trim()
  if (clean.length === 0) { return '' }
  const fileName = src.split('/').pop() ?? ''
  if (clean === fileName) { return '' }
  // "rack-photo.png" as alt text is the asset browser's doing, not a person's.
  return FILENAME_ALT.test(clean) && !clean.includes(' ') ? '' : clean
}

interface Span {
  start: number
  end: number
  innerStart: number
  inner: string
}

function spansOf (pattern: RegExp, html: string): Span[] {
  const spans: Span[] = []
  let match = pattern.exec(html)
  while (match !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      innerStart: match.index + match[0].indexOf('>') + 1,
      inner: match[1] ?? ''
    })
    match = pattern.exec(html)
  }
  return spans
}

function attributesOf (tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = new RegExp(ATTRIBUTE.source, 'g')
  let match = pattern.exec(tag)
  while (match !== null) {
    if (match[1] && match[2] !== undefined) { attrs[match[1].toLowerCase()] = decodeHtml(match[2]) }
    match = pattern.exec(tag)
  }
  return attrs
}

function plain (html: string): string {
  return decodeHtml(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function decodeHtml (value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    // Last, or "&amp;lt;" would come out as "<".
    .replace(/&amp;/g, '&')
}
