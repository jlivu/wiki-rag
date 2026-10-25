/**
 * Spreadsheets and CSV, a section per sheet.
 *
 * A row means nothing without its column names, and a chunk may hold any
 * run of rows, so the header travels with the section and is repeated at
 * the top of every chunk cut from it.
 */
import { parse } from 'csv-parse/sync'
import readXlsxFile from 'read-excel-file/node'

import { ExtractionError, type DocSection, type Extraction } from './types.js'

/** Cells are joined with this, the same separator a table snippet uses. */
const CELL = ' · '

export async function extractXlsx (bytes: Buffer): Promise<Extraction> {
  let sheets: Array<{ sheet: string, data: unknown[][] }>
  try {
    sheets = await readXlsxFile(bytes) as unknown as Array<{ sheet: string, data: unknown[][] }>
  } catch (err) {
    throw new ExtractionError(
      `the workbook could not be read (${err instanceof Error ? err.message : 'unknown error'})`
    )
  }

  const sections: DocSection[] = []
  for (const { sheet, data } of sheets) {
    const rows = data.map(row => row.map(cellText))
    const section = sheetSection(`Sheet "${sheet}"`, rows)
    if (section) { sections.push(section) }
  }
  return { sections }
}

export function extractCsv (bytes: Buffer): Extraction {
  const text = bytes.toString('utf8')
  let rows: string[][]
  try {
    rows = parse(text, {
      bom: true,
      delimiter: sniffDelimiter(text),
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true
    }) as string[][]
  } catch (err) {
    throw new ExtractionError(
      `the file could not be read as CSV (${err instanceof Error ? err.message : 'unknown error'})`
    )
  }

  // A CSV has no sheet name, and the file name is already the chunk's
  // prefix, so the location is just the rows.
  const section = sheetSection('', rows)
  return { sections: section ? [section] : [] }
}

/**
 * The first row is the header when it reads like one — every cell filled in
 * and none of them a number. A file that opens straight into data keeps
 * every row.
 */
function sheetSection (label: string, rows: string[][]): DocSection | null {
  const used = rows.filter(row => row.some(cell => cell.length > 0))
  if (used.length === 0) { return null }

  const first = used[0] as string[]
  const headerLike = used.length > 1 && first.every(cell => cell.length > 0 && !isNumber(cell))
  const header = headerLike ? first.join(CELL) : undefined
  const body = headerLike ? used.slice(1) : used

  const text = body.map(row => row.join(CELL)).join('\n')
  if (text.trim().length === 0) { return null }

  return {
    label,
    anchor: '',
    text,
    ...(header ? { header } : {}),
    // Spreadsheet rows are numbered from 1, and the header was row 1.
    firstRow: headerLike ? 2 : 1
  }
}

function isNumber (cell: string): boolean {
  const clean = cell.replace(/[\s,]/g, '')
  return clean.length > 0 && Number.isFinite(Number(clean))
}

/** A cell keeps the type the sheet stored it as; a date reads as a date. */
function cellText (cell: unknown): string {
  if (cell === null || cell === undefined) { return '' }
  if (cell instanceof Date) { return cell.toISOString().slice(0, 10) }
  if (typeof cell === 'number' || typeof cell === 'boolean') { return String(cell) }
  return String(cell).replace(/\s+/g, ' ').trim()
}

/** A European export is semicolon-separated; guess from the first line. */
function sniffDelimiter (text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? ''
  const counts = [',', ';', '\t'].map(candidate => ({
    candidate,
    count: line.split(candidate).length - 1
  }))
  const best = counts.sort((a, b) => b.count - a.count)[0]
  return best && best.count > 0 ? best.candidate : ','
}
