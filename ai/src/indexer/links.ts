/**
 * Which uploaded files a page links to.
 *
 * A reader who is shown a file as a source wants to know where it is used,
 * so every page's rendered HTML is scanned as it is indexed and its links
 * to assets are recorded. Wiki.js has no table for this: `pageLinks` holds
 * page-to-page links only.
 */

/** href and src, in that order of likelihood. */
const ATTRIBUTE = /\b(?:href|src)="([^"]+)"/gi
/** A locale segment at the front of a URL, which Wiki.js strips itself. */
const LOCALE = /^[a-z]{2}(-[a-z]{2})?$/i

export interface LinkScanOptions {
  /** Hosts whose absolute URLs are really this wiki. */
  origins?: readonly string[]
  /** Extensions Wiki.js serves as pages; those links are not files. */
  pageExtensions: readonly string[]
}

export function assetLinksFrom (html: string, options: LinkScanOptions): string[] {
  if (typeof html !== 'string' || html.length === 0) { return [] }

  const found = new Set<string>()
  let match = ATTRIBUTE.exec(html)
  while (match !== null) {
    const path = assetPathOf(match[1] ?? '', options)
    if (path) { found.add(path) }
    match = ATTRIBUTE.exec(html)
  }
  ATTRIBUTE.lastIndex = 0
  return [...found]
}

/** The asset path a link or an image source points at, or null. */
export function assetPathOf (href: string, options: LinkScanOptions): string | null {
  let value = decodeHtml(href).trim()
  if (value.length === 0) { return null }

  // An absolute URL counts only if it is this wiki.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const origin = (options.origins ?? []).find(candidate => value.startsWith(`${candidate}/`))
    if (!origin) { return null }
    value = value.slice(origin.length)
  }
  // A relative link is relative to a page, not to the site root, and the
  // page it sits on is not known here. Wiki.js's editors write root-
  // relative links, so anything else is left alone.
  if (!value.startsWith('/')) { return null }

  const [withoutHash = ''] = value.split('#')
  const [clean = ''] = withoutHash.split('?')
  const parts = clean.replace(/^\/+/, '').split('/').filter(part => part.length > 0)
  if (parts.length === 0) { return null }

  // The wiki's own routes, none of which are uploads.
  if (['_assets', '_userav', 'graphql', 'login', 'logout'].includes(parts[0] as string)) { return null }
  if ((parts[0] as string).length <= 2 && parts.length > 1 && LOCALE.test(parts[0] as string)) { parts.shift() }

  const path = decodePath(parts.join('/'))
  const last = parts[parts.length - 1] as string
  const dot = last.lastIndexOf('.')
  if (dot <= 0) { return null }

  const ext = last.slice(dot + 1).toLowerCase()
  if (options.pageExtensions.includes(ext)) { return null }

  return path
}

function decodePath (path: string): string {
  try {
    return decodeURI(path)
  } catch {
    return path
  }
}

function decodeHtml (value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_m, code: string) =>
    String.fromCodePoint(Number(code)))
}
