/**
 * The sources of one run, and the citations that point at them.
 *
 * Every page a tool returns is registered here and given a short id — S1,
 * S2 — that the model can write inline. Resolving those markers back into
 * links happens here, on the server, from what the tools actually
 * returned: a title or a URL never comes from text the model wrote, and a
 * marker that matches nothing is dropped rather than rendered.
 */

/** A page, or an uploaded file. */
export type SourceKind = 'page' | 'document'

export interface LinkingPageRef {
  title: string
  path: string
  locale: string
}

export interface RunSource {
  /** What the model cites: S1, S2, … */
  id: string
  kind: SourceKind
  title: string
  path: string
  /** Empty for a document: uploaded files are not localised. */
  locale: string
  /** Wiki.js's anchor for the section, or "#page=4" in a PDF. */
  anchor: string
  /** Heading path of that section, for the card. */
  section: string
  snippet: string
  updatedAt: string
  /** Where a reader opens it, section or page included. */
  url: string
  /** True once the page or file was actually read, not merely listed. */
  read: boolean
  /* Documents only. */
  fileName: string
  /** pdf, docx, xlsx, pptx, csv — what the panel draws an icon from. */
  fileType: string
  /** Where in the file: "Page 4", "Sheet \"Budget\" rows 12–40". */
  location: string
  /** For an image: 'ocr', 'alt' or 'description'. */
  origin: string
  /** The pages that link to the file, as far as this reader may see. */
  linkedFrom: LinkingPageRef[]
}

export interface SourceInput {
  kind?: SourceKind
  title: string
  path: string
  locale?: string
  anchor?: string
  section?: string
  snippet?: string
  updatedAt?: string
  read?: boolean
  fileName?: string
  fileType?: string
  location?: string
  origin?: string
  linkedFrom?: LinkingPageRef[]
}

export class SourceRegistry {
  readonly #publicUrl: string
  /** One entry per page, keyed by locale and path. */
  readonly #byPage = new Map<string, RunSource>()
  readonly #byId = new Map<string, RunSource>()
  /** Ids in the order the model first cited them. */
  readonly #citedOrder: string[] = []
  /** Pages read with get_page, in the order they were read. */
  readonly #readOrder: string[] = []

  constructor (publicUrl: string) {
    this.#publicUrl = publicUrl.replace(/\/+$/, '')
  }

  /**
   * Record a page a tool returned. Seeing the same page again fills in
   * anything that was missing the first time rather than adding a second
   * entry, so one page is one source for the whole run.
   */
  register (input: SourceInput): RunSource {
    const kind = input.kind ?? 'page'
    const path = input.path.replace(/^\/+/, '')
    const locale = kind === 'document' ? '' : (input.locale ?? '')
    const key = `${kind}\n${locale}\n${path}`
    const existing = this.#byPage.get(key)

    if (existing) {
      if (!existing.anchor && input.anchor) { existing.anchor = input.anchor }
      if (!existing.section && input.section) { existing.section = input.section }
      if (!existing.snippet && input.snippet) { existing.snippet = input.snippet }
      if (!existing.updatedAt && input.updatedAt) { existing.updatedAt = input.updatedAt }
      if (!existing.location && input.location) { existing.location = input.location }
      if (!existing.origin && input.origin) { existing.origin = input.origin }
      if (existing.linkedFrom.length === 0 && input.linkedFrom) { existing.linkedFrom = input.linkedFrom }
      if (input.read && !existing.read) {
        existing.read = true
        this.#readOrder.push(existing.id)
      }
      existing.url = this.#url(existing)
      return existing
    }

    const source: RunSource = {
      id: `S${this.#byPage.size + 1}`,
      kind,
      title: input.title || path,
      path,
      locale,
      anchor: input.anchor ?? '',
      section: input.section ?? '',
      snippet: input.snippet ?? '',
      updatedAt: input.updatedAt ?? '',
      url: '',
      read: input.read === true,
      fileName: input.fileName ?? '',
      fileType: input.fileType ?? '',
      location: input.location ?? '',
      origin: input.origin ?? '',
      linkedFrom: input.linkedFrom ?? []
    }
    source.url = this.#url(source)
    this.#byPage.set(key, source)
    this.#byId.set(source.id, source)
    if (source.read) { this.#readOrder.push(source.id) }
    return source
  }

  /** Record a citation and return its 1-based number, or null if unknown. */
  cite (id: string): { source: RunSource, number: number } | null {
    const source = this.#byId.get(id.toUpperCase())
    if (!source) { return null }
    let at = this.#citedOrder.indexOf(source.id)
    if (at < 0) {
      this.#citedOrder.push(source.id)
      at = this.#citedOrder.length - 1
    }
    return { source, number: at + 1 }
  }

  /** The sources the answer cited, in citation order. */
  get cited (): RunSource[] {
    return this.#citedOrder.flatMap(id => {
      const source = this.#byId.get(id)
      return source ? [source] : []
    })
  }

  /** The pages actually read, in the order they were read. */
  get read (): RunSource[] {
    return this.#readOrder.flatMap(id => {
      const source = this.#byId.get(id)
      return source ? [source] : []
    })
  }

  #url (source: RunSource): string {
    // An uploaded file sits at the site root with no locale segment: the
    // catch-all route strips one, so adding it would be wrong by luck.
    return source.kind === 'document'
      ? `${this.#publicUrl}/${source.path}${source.anchor}`
      : `${this.#publicUrl}/${source.locale}/${source.path}${source.anchor}`
  }
}

/* ── rewriting the markers in streamed text ────────────────────────── */

/** `[S1]`, `[S1, S2]`, `[s1,S3]` — one or more ids in one bracket. */
const MARKER = /\[\s*([sS]\d+(?:\s*,\s*[sS]\d+)*)\s*\]/g
/** A marker that has only partly arrived, at the very end of the buffer. */
const PARTIAL = /\[\s*(?:[sS]\d*(?:\s*,\s*(?:[sS]\d*)?)*)?$/

/**
 * Turns `[S1]` into a numbered link as the text streams.
 *
 * A marker can be split across two deltas, so the tail of the buffer is
 * held back until it is either a complete marker or clearly not one.
 */
export class CitationRewriter {
  readonly #sources: SourceRegistry
  #held = ''

  constructor (sources: SourceRegistry) {
    this.#sources = sources
  }

  /** Text that is safe to send now. */
  push (delta: string): string {
    const buffer = this.#held + delta
    const partial = PARTIAL.exec(buffer)
    // Keep anything that could still turn into a marker.
    const cut = partial && partial.index > buffer.length - 24 ? partial.index : buffer.length
    this.#held = buffer.slice(cut)
    return this.#rewrite(buffer.slice(0, cut))
  }

  /** Whatever is still held back, once the message has ended. */
  flush (): string {
    const rest = this.#held
    this.#held = ''
    return this.#rewrite(rest)
  }

  #rewrite (text: string): string {
    if (text.length === 0) { return text }
    return text.replace(MARKER, (_match, ids: string) => {
      const numbers = ids
        .split(',')
        .flatMap(id => {
          const cited = this.#sources.cite(id.trim())
          return cited ? [cited.number] : []
        })
      // A marker naming nothing this run returned is dropped outright.
      if (numbers.length === 0) { return '' }
      return numbers.map(number => `[${number}](cite:${number})`).join('')
    }).replace(/[ \t]+([.,;:!?])/g, '$1')
  }
}
