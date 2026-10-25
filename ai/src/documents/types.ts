/**
 * What an extractor returns: text that still knows where it came from.
 *
 * A citation has to name a place a reader can go back to — page 4, the
 * section called "Pricing", slide 7, rows 12 to 40 of the Budget sheet — so
 * text is never flattened into one string. Each extractor produces the
 * sections its format actually has.
 */

export interface DocSection {
  /** Shown to the reader: `Page 4`, `Section "Pricing"`, `Slide 7`. */
  label: string
  /** URL fragment that opens that place, or '' when there is none. */
  anchor: string
  /** The section's text, one line per row when the lines are rows. */
  text: string
  /** Repeated at the top of every chunk cut from this section. */
  header?: string
  /**
   * The source row number of the first line, for a sheet or a CSV. A chunk
   * cut out of the middle can then say which rows it holds.
   */
  firstRow?: number
}

export interface Extraction {
  sections: DocSection[]
  /** A PDF with no text layer: a scan, which would need OCR. */
  needsOcr?: boolean
}

/** What we know about a file before reading it. */
export interface DocumentMeta {
  /** Folder slugs and the file name, as Wiki.js serves it. */
  path: string
  fileName: string
  /** Lower case, with the dot: ".pdf". */
  ext: string
  mime: string
}

/** Thrown when a file is of a kind we handle but cannot be read. */
export class ExtractionError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ExtractionError'
  }
}
