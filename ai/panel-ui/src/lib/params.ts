import { mediaUrl, type PageContext } from '@shared'

export type PanelTheme = 'light' | 'dark'

export interface PanelParams {
  page: PageContext
  theme: PanelTheme
}

/**
 * The wiki panel passes the page it is on, and its theme, as query
 * parameters. See client/components/ai/chat-drawer.vue.
 */
export function readPanelParams (search = window.location.search): PanelParams {
  const params = new URLSearchParams(search)
  return {
    page: {
      path: params.get('path') ?? '',
      locale: params.get('locale') ?? 'en',
      title: params.get('title') ?? ''
    },
    theme: params.get('theme') === 'dark' ? 'dark' : 'light'
  }
}

export function applyTheme (theme: PanelTheme): void {
  document.documentElement.dataset.theme = theme
}

/** The address of a wiki page, for a link out of the iframe. */
export function wikiHref (path: string, locale: string | undefined, fallbackLocale: string): string {
  const trimmed = path.replace(/^\/+/, '')
  return `/${locale || fallbackLocale}/${trimmed}`
}

/**
 * The address of a source, including the place the answer came from: the
 * section of a page, the page of a PDF, or the moment in a video.
 *
 * An uploaded file is served from the site root with no locale segment —
 * Wiki.js strips one from an asset URL — so only a page gets one. A video
 * is not in the wiki at all: it is served by the AI service from the
 * media folder, and its "#t=" opens it where the answer came from.
 */
export function sourceHref (
  source: {
    path: string
    locale?: string
    anchor?: string
    kind?: 'page' | 'document' | 'video'
    startsAt?: number
  },
  fallbackLocale: string
): string {
  if (source.kind === 'video') {
    return mediaUrl(source.path, source.startsAt)
  }
  const raw = source.anchor?.trim() ?? ''
  const anchor = raw.length === 0 ? '' : (raw.startsWith('#') ? raw : `#${raw}`)
  const path = source.kind === 'document'
    ? `/${source.path.replace(/^\/+/, '')}`
    : wikiHref(source.path, source.locale, fallbackLocale)
  return `${path}${anchor}`
}
