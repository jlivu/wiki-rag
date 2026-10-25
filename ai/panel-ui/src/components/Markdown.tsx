import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
          // The panel sits in an iframe; links belong in the main window.
          a: ({ node, ...props }) => <a {...props} target="_top" rel="noopener noreferrer" />
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
