/**
 * One entry point for every format the index understands.
 */
import { extractDocx } from './docx.js'
import type { DocType } from './kind.js'
import { extractPdf } from './pdf.js'
import { extractPptx } from './pptx.js'
import { extractCsv, extractXlsx } from './sheets.js'
import { extractPlainText } from './text.js'
import type { Extraction } from './types.js'

export async function extractDocument (bytes: Buffer, docType: DocType): Promise<Extraction> {
  switch (docType) {
    case 'pdf': return extractPdf(bytes)
    case 'docx': return extractDocx(bytes)
    case 'pptx': return extractPptx(bytes)
    case 'xlsx': return extractXlsx(bytes)
    case 'csv': return extractCsv(bytes)
    case 'markdown': return extractPlainText(bytes, true)
    case 'text': return extractPlainText(bytes, false)
  }
}
