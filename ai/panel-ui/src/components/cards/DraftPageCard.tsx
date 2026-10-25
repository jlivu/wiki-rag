import { useId, useState } from 'react'
import type { DraftPageArgs } from '@shared'

import { DraftIcon } from '../Icons'
import { Card } from './Card'

/**
 * A draft the reader can edit before it becomes a page. Creating the page
 * needs the wiki's GraphQL API and the reader's own permissions, which is a
 * later step, so the button is deliberately disabled.
 */
export function DraftPageCard ({ args }: { args: DraftPageArgs }) {
  const [title, setTitle] = useState(args.title)
  const [path, setPath] = useState(args.path)
  const [body, setBody] = useState(args.body)
  const id = useId()

  return (
    <Card icon={<DraftIcon />} title="Draft page">
      <div className="draft">
        <label className="draft-label" htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          className="draft-input"
          value={title}
          onChange={event => setTitle(event.target.value)}
        />

        <label className="draft-label" htmlFor={`${id}-path`}>Path</label>
        <input
          id={`${id}-path`}
          className="draft-input draft-mono"
          value={path}
          onChange={event => setPath(event.target.value)}
          spellCheck={false}
        />

        <label className="draft-label" htmlFor={`${id}-body`}>Body (Markdown)</label>
        <textarea
          id={`${id}-body`}
          className="draft-input draft-mono draft-body"
          value={body}
          onChange={event => setBody(event.target.value)}
          rows={8}
          spellCheck={false}
        />

        <button className="draft-create" type="button" disabled>
          Create page (coming soon)
        </button>
      </div>
    </Card>
  )
}
