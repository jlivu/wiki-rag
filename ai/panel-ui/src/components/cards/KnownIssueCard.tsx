import type { KnownIssueArgs } from '@shared'

import { NEW_TAB_LINK, NewTabHint } from '../ExternalLink'
import { AlertIcon } from '../Icons'
import { wikiHref } from '../../lib/params'
import { Card } from './Card'

export function KnownIssueCard ({ args, locale }: {
  args: KnownIssueArgs
  locale: string
}) {
  return (
    <Card icon={<span className="aic-head-alert"><AlertIcon /></span>} title={args.title}>
      <div className="issue">
        <div className="issue-row">
          <h4 className="issue-label">Symptoms</h4>
          <ul className="issue-symptoms">
            {args.symptoms.map((symptom, index) => <li key={index}>{symptom}</li>)}
          </ul>
        </div>
        <div className="issue-row">
          <h4 className="issue-label">Root cause</h4>
          <p className="issue-text">{args.rootCause}</p>
        </div>
        <div className="issue-row">
          <h4 className="issue-label">Fix</h4>
          <p className="issue-text">{args.fix}</p>
        </div>
        {args.affectedVersions.length > 0
          ? (
            <div className="issue-row">
              <h4 className="issue-label">Affected versions</h4>
              <p className="badges">
                {args.affectedVersions.map((version, index) => (
                  <span className="badge" key={index}>{version}</span>
                ))}
              </p>
            </div>
            )
          : null}
        {args.source
          ? (
            <a className="issue-source" href={wikiHref(args.source.path, args.source.locale, locale)} {...NEW_TAB_LINK}>
              {args.source.title}
              <NewTabHint />
            </a>
            )
          : null}
      </div>
    </Card>
  )
}
