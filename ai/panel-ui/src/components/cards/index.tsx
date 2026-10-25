import type { PanelComponent } from '@shared'

import { ChecklistCard } from './ChecklistCard'
import { DraftPageCard } from './DraftPageCard'
import { KnownIssueCard } from './KnownIssueCard'
import { SourcesCard } from './SourcesCard'
import { TableCard } from './TableCard'

/**
 * The fixed set of answer components. A tool call that is not one of these
 * never reaches here: parsePanelComponent drops it first.
 */
export function AnswerComponent ({ component, locale }: {
  component: PanelComponent
  locale: string
}) {
  switch (component.name) {
    case 'sources':
      return <SourcesCard args={component.args} locale={locale} />
    case 'checklist':
      return <ChecklistCard args={component.args} />
    case 'known_issue':
      return <KnownIssueCard args={component.args} locale={locale} />
    case 'table':
      return <TableCard args={component.args} />
    case 'draft_page':
      return <DraftPageCard args={component.args} />
  }
}
