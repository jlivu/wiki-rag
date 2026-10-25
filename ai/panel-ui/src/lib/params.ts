import type { PageContext } from '@shared'

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
