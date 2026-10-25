import type { SourcesArgs } from '@shared'

import { NEW_TAB_LINK, NewTabHint } from '../ExternalLink'
import { ClockIcon, SourcesIcon } from '../Icons'
import { sourceHref } from '../../lib/params'
import { Card } from './Card'

/**
 * The pages an answer came from, numbered to match the inline markers in
 * the text above: the first entry here is [1] there.
 */
export function SourcesCard ({ args, locale }: {
  args: SourcesArgs
  locale: string
}) {
  return (
    <Card icon={<SourcesIcon />} title={args.items.length === 1 ? '1 source' : `${args.items.length} sources`}>
      <ol className="src-list">
        {args.items.map((item, index) => {
          const href = sourceHref(item, locale)
          return (
            <li key={`${item.path}-${index}`}>
              <a className="src" href={href} {...NEW_TAB_LINK}>
                <span className="src-no" aria-hidden="true">{index + 1}</span>
                <span className="src-body">
                  <span className="src-title">
                    {item.title}
                    <NewTabHint />
                  </span>
                  {item.section ? <span className="src-section">{item.section}</span> : null}
                  <span className="src-path">{href}</span>
                  <span className="src-snippet">{item.snippet}</span>
                  {item.updatedAt
                    ? (
                      <span className="src-date">
                        <ClockIcon />
                        Updated {formatDate(item.updatedAt)}
                      </span>
                      )
                    : null}
                </span>
              </a>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function formatDate (value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) { return value }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
