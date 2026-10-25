/**
 * Creating a wiki page from a draft card.
 *
 * The rules here are Wiki.js's own, repeated on purpose: the panel checks a
 * path before sending it so the reader is told what is wrong while they can
 * still fix it, and the service checks the same path again because a
 * browser is not to be trusted. Both halves import this file, so the two
 * answers cannot drift.
 */

export const PAGES_PATH = '/ai/api/pages'

/** Every page the assistant has a hand in carries this. */
export const AI_DRAFT_TAG = 'ai-draft'

/**
 * Put at the top of a drafted page. It is a Wiki.js warning block, and it
 * says plainly that a person has to check the page and take the note out.
 */
export const DRAFT_NOTE = [
  '> **Draft written by the wiki assistant.** Nothing here has been checked by a person.',
  '> Read it against the sources, correct what is wrong, delete this note, then publish.',
  '{.is-warning}'
].join('\n')

/** Add the note unless it is already there. */
export function withDraftNote (content: string): string {
  const body = content.trim()
  return body.startsWith('> **Draft written by the wiki assistant.**')
    ? body
    : `${DRAFT_NOTE}\n\n${body}`
}

/* ── what the panel sends and gets back ────────────────────────────── */

export interface CreatePageRequest {
  title: string
  path: string
  content: string
  description?: string
  locale?: string
}

export interface CreatedPage {
  id: number
  title: string
  path: string
  locale: string
  /** Where the reader goes to carry on working: the Wiki.js editor. */
  editUrl: string
  /** Where the page will be once it is published. */
  viewUrl: string
}

export type CreatePageResult =
  | { ok: true, page: CreatedPage }
  | {
      ok: false
      error: string
      /** `exists`, `forbidden`, `path`, `unavailable` or `failed`. */
      reason: string
      /** For `exists`: where the page that is in the way can be read. */
      existingUrl?: string
    }

/* ── path rules, Wiki.js's own ─────────────────────────────────────── */

/**
 * First folders Wiki.js keeps for itself (server/app/data.yml), plus the
 * single letters its routes use. A page under one of these is created
 * happily by GraphQL and then cannot be opened: `isReservedPath` is
 * checked by the editor route, not by `pages.create`.
 */
const RESERVED_FIRST = [
  'login', 'logout', 'register', 'verify', 'favicons', 'fonts', 'img', 'js', 'svg'
]

/** Wiki.js's own: two letters, or two and two, is a language code. */
const LOCALE_SHAPED = /^[a-z]{2}(-[a-z]{2})?$/i
/** server/helpers/page.js, unsafeCharsRegex. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\x00-\x1f\x80-\x9f\\"|<>:*?]/

export type PathCheck =
  | { ok: true, path: string }
  | { ok: false, error: string }

/**
 * Clean a path up and say whether Wiki.js will take it.
 *
 * The cleaning is the part Wiki.js would do anyway — trimming, dropping a
 * leading slash, dropping a locale segment the reader typed. The refusals
 * are the cases where a page would be created and then be unreachable, or
 * be refused outright by `pages.create`.
 */
export function checkPagePath (rawPath: string, locale: string): PathCheck {
  let path = (rawPath ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (path.toLowerCase().startsWith(`${locale.toLowerCase()}/`)) {
    path = path.slice(locale.length + 1)
  }

  if (path.length === 0) {
    return { ok: false, error: 'Give the page a path, for example ops/backups.' }
  }
  if (UNSAFE.test(path)) {
    return { ok: false, error: 'A page path cannot contain " \\ | < > : * ? or control characters.' }
  }
  // pages.create refuses all four outright (server/models/pages.js).
  if (path.includes(' ')) {
    return { ok: false, error: 'A page path cannot contain spaces. Use hyphens instead.' }
  }
  if (path.includes('.')) {
    return { ok: false, error: 'A page path cannot contain a dot. Leave the file extension off.' }
  }
  if (path.includes('\\') || path.includes('//')) {
    return { ok: false, error: 'A page path cannot contain \\ or an empty folder.' }
  }

  const first = path.split('/')[0] ?? ''
  if (first.length <= 1) {
    return {
      ok: false,
      error: `"${first}" is too short for a first folder: the wiki reads a single letter as one of its own routes.`
    }
  }
  if (LOCALE_SHAPED.test(first)) {
    return {
      ok: false,
      error: `The wiki reads "${first}" as a language code, not a folder. Start the path with a longer word.`
    }
  }
  if (RESERVED_FIRST.includes(first.toLowerCase())) {
    return {
      ok: false,
      error: `"${first}" is reserved by the wiki. Start the path with something else.`
    }
  }

  return { ok: true, path }
}

/** Where Wiki.js opens a page for editing. */
export function editorUrl (publicUrl: string, locale: string, path: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/e/${locale}/${path.replace(/^\/+/, '')}`
}
