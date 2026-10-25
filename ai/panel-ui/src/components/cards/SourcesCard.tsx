import type { SourcesArgs } from '@shared'

import { ClockIcon, SourcesIcon } from '../Icons'
import { wikiHref } from '../../lib/params'
import { Card } from './Card'

export function SourcesCard ({ args, locale }: {
  args: SourcesArgs
  locale: string
}) {
  return (
    <Card icon={<SourcesIcon />} title={args.items.length === 1 ? '1 source' : `${args.items.length} sources`}>
      <ul className="src-list">
        {args.items.map((item, index) => (
          <li key={`${item.path}-${index}`}>
            {/* _top: the panel is in an iframe, the wiki page is not. */}
            <a className="src" href={wikiHref(item.path, item.locale, locale)} target="_top">
              <span className="src-title">{item.title}</span>
              <span className="src-path">{wikiHref(item.path, item.locale, locale)}</span>
              <span className="src-snippet">{item.snippet}</span>
              {item.updatedAt
                ? (
                  <span className="src-date">
                    <ClockIcon />
                    Updated {formatDate(item.updatedAt)}
                  </span>
                  )
                : null}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function formatDate (value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) { return value }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
