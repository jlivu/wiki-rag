import { Fragment } from 'react'

import type { Source, SourcesArgs } from '@shared'

import { NEW_TAB_LINK, NewTabHint } from '../ExternalLink'
import { ClockIcon, FileIcon, SourcesIcon } from '../Icons'
import { sourceHref, wikiHref } from '../../lib/params'
import { Card } from './Card'

/**
 * What an answer came from, numbered to match the inline markers in the
 * text above: the first entry here is [1] there.
 *
 * A wiki page is one link. An uploaded file is not: its own link opens the
 * file — at the cited page, for a PDF — and the pages that link to it are
 * links of their own, so that entry is laid out rather than wrapped.
 */
export function SourcesCard ({ args, locale }: {
  args: SourcesArgs
  locale: string
}) {
  return (
    <Card icon={<SourcesIcon />} title={args.items.length === 1 ? '1 source' : `${args.items.length} sources`}>
      <ol className="src-list">
        {args.items.map((item, index) => (
          <li key={`${item.path}-${index}`}>
            {item.kind === 'document'
              ? <DocumentSource item={item} number={index + 1} locale={locale} />
              : <PageSource item={item} number={index + 1} locale={locale} />}
          </li>
        ))}
      </ol>
    </Card>
  )
}

function PageSource ({ item, number, locale }: { item: Source, number: number, locale: string }) {
  const href = sourceHref(item, locale)
  return (
    <a className="src" href={href} {...NEW_TAB_LINK}>
      <span className="src-no" aria-hidden="true">{number}</span>
      <span className="src-body">
        <span className="src-title">
          {item.title}
          <NewTabHint />
        </span>
        {item.section ? <span className="src-section">{item.section}</span> : null}
        <span className="src-path">{href}</span>
        <span className="src-snippet">{item.snippet}</span>
        <Updated at={item.updatedAt} />
      </span>
    </a>
  )
}

function DocumentSource ({ item, number, locale }: { item: Source, number: number, locale: string }) {
  const href = sourceHref(item, locale)
  const name = item.fileName ?? item.title
  const where = [fileTypeLabel(item.fileType), item.location ?? item.section]
    .filter(part => part && part.length > 0)
    .join(' · ')
  const linked = item.linkedFrom ?? []
  // A description was written by a model, not read off the image: say so
  // where the reader is looking, not only in the location line.
  const generated = item.origin === 'description'

  return (
    <div className="src src-doc">
      <span className="src-no" aria-hidden="true">{number}</span>
      <span className="src-body">
        <a className="src-title src-file" href={href} {...NEW_TAB_LINK}>
          <FileIcon type={item.fileType} />
          {name}
          <NewTabHint />
        </a>
        {where.length > 0 || generated
          ? (
            <span className="src-section">
              {where}
              {generated ? <span className="src-generated">generated, not read from the image</span> : null}
            </span>
            )
          : null}
        <span className="src-path">{href}</span>
        <span className="src-snippet">{item.snippet}</span>
        {linked.length > 0
          ? (
            <span className="src-linked">
              Linked from{' '}
              {linked.map((page, at) => (
                <Fragment key={`${page.path}-${at}`}>
                  {at > 0 ? ', ' : null}
                  <a href={wikiHref(page.path, page.locale, locale)} {...NEW_TAB_LINK}>
                    {page.title}
                    <NewTabHint />
                  </a>
                </Fragment>
              ))}
            </span>
            )
          : null}
        <Updated at={item.updatedAt} />
      </span>
    </div>
  )
}

function Updated ({ at }: { at?: string }) {
  if (!at) { return null }
  return (
    <span className="src-date">
      <ClockIcon />
      Updated {formatDate(at)}
    </span>
  )
}

function fileTypeLabel (fileType?: string): string {
  const type = (fileType ?? '').trim()
  // "IMAGE" says nothing the icon has not already said.
  return type.toLowerCase() === 'image' ? '' : type.toUpperCase()
}

function formatDate (value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) { return value }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
