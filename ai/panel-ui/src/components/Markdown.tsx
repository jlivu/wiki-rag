import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { Source } from '@shared'

import { Citation } from './Citation'
import { NEW_TAB_LINK, NewTabHint } from './ExternalLink'

/** What the server writes an inline citation as: [1](cite:1). */
const CITE_SCHEME = 'cite:'

/**
 * Assistant text is Markdown. Raw HTML stays off: there is no rehype-raw
 * here on purpose, so a model cannot inject markup into the panel.
 */
export function Markdown ({ text, sources = [], locale = 'en' }: {
  text: string
  /** The reply's sources, in citation order: index n-1 is marker [n]. */
  sources?: Source[]
  locale?: string
}) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // cite: is the panel's own scheme; the default transform would drop
        // it as an unknown protocol. Everything else is still sanitised.
        urlTransform={url => (url.startsWith(CITE_SCHEME) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ node, children, href, ...props }) => (
            href?.startsWith(CITE_SCHEME)
              ? <Citation marker={href.slice(CITE_SCHEME.length)} sources={sources} locale={locale} />
              // The panel sits in an iframe; nothing may ever load inside it.
              : (
                <a {...props} href={href} {...NEW_TAB_LINK}>
                  {children}
                  <NewTabHint />
                </a>
                )
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
