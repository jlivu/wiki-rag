import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { NEW_TAB_LINK, NewTabHint } from './ExternalLink'

/**
 * Assistant text is Markdown. Raw HTML stays off: there is no rehype-raw
 * here on purpose, so a model cannot inject markup into the panel.
 */
export function Markdown ({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // The panel sits in an iframe; nothing may ever load inside it.
          a: ({ node, children, ...props }) => (
            <a {...props} {...NEW_TAB_LINK}>
              {children}
              <NewTabHint />
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
