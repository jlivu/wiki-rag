import type { Source } from '@shared'

import { sourceHref } from '../lib/params'
import { NEW_TAB_LINK } from './ExternalLink'

/**
 * An inline [1] beside the statement it supports.
 *
 * The number is a position in the run's sources card, and the link and the
 * title are read from that card — never from the text the model wrote. A
 * marker with nothing behind it (the card has not arrived yet, or it named
 * a source this run did not return) stays plain text rather than becoming
 * a link to nowhere.
 */
export function Citation ({ marker, sources, locale }: {
  marker: string
  sources: Source[]
  locale: string
}) {
  const number = Number(marker)
  const source = Number.isInteger(number) && number >= 1 ? sources[number - 1] : undefined

  if (!source) {
    return <span className="cite cite-plain">{marker}</span>
  }

  const where = [source.title, source.section].filter(Boolean).join(' › ')
  return (
    <a className="cite" href={sourceHref(source, locale)} title={where} {...NEW_TAB_LINK}>
      <span aria-hidden="true">{number}</span>
      <span className="sr-only">{`Source ${number}, ${where} (opens in a new tab)`}</span>
    </a>
  )
}
