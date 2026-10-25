/**
 * Which draft cards have already made a page.
 *
 * Deliberately *not* part of the card's arguments. Those arrive from the
 * model and are re-checked from storage on every reload, so a model that
 * wrote `created: { editUrl: … }` into a tool call would put a link of its
 * own choosing in front of the reader. This store is written only by a
 * real answer from our own endpoint, and the model cannot reach it.
 *
 * It lives beside the conversation in sessionStorage, which is what makes
 * the created state survive a reload of the panel.
 */
import type { CreatedPage } from '@shared'

const STORAGE_KEY = 'wiki-ai-created-pages'

/** One card, for as long as the conversation lasts: message id and part. */
export function cardKey (messageId: string, part: number): string {
  return `${messageId}:${part}`
}

export function createdPageFor (key: string): CreatedPage | null {
  const all = read()
  const page = all[key]
  return page ?? null
}

export function rememberCreatedPage (key: string, page: CreatedPage): void {
  const all = read()
  all[key] = page
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage full or switched off: the state lasts this page view only.
  }
}

/** A new chat starts clean; the pages themselves of course remain. */
export function forgetCreatedPages (): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // As above.
  }
}

function read (): Record<string, CreatedPage> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) { return {} }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) { return {} }

    const out: Record<string, CreatedPage> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const page = readPage(value)
      if (page) { out[key] = page }
    }
    return out
  } catch {
    return {}
  }
}

/** Our own data, checked anyway: storage is shared with the whole tab. */
function readPage (value: unknown): CreatedPage | null {
  if (typeof value !== 'object' || value === null) { return null }
  const page = value as Record<string, unknown>
  const strings = ['title', 'path', 'locale', 'editUrl', 'viewUrl'] as const
  if (typeof page.id !== 'number') { return null }
  for (const field of strings) {
    if (typeof page[field] !== 'string' || (page[field] as string).length === 0) { return null }
  }
  // Only a link back into this wiki, never an absolute one from elsewhere.
  for (const field of ['editUrl', 'viewUrl'] as const) {
    const url = page[field] as string
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith(window.location.origin)) { return null }
  }
  return {
    id: page.id,
    title: page.title as string,
    path: page.path as string,
    locale: page.locale as string,
    editUrl: page.editUrl as string,
    viewUrl: page.viewUrl as string
  }
}
