import type { ChecklistArgs } from '@shared'

import { ChecklistIcon } from '../Icons'
import { Card } from './Card'

export function ChecklistCard ({ args }: { args: ChecklistArgs }) {
  return (
    <Card icon={<ChecklistIcon />} title={args.title ?? 'Steps'}>
      <ol className="steps">
        {args.steps.map((step, index) => (
          <li key={index}>
            <span className="step-no" aria-hidden="true">{index + 1}</span>
            <div className="step-body">
              <span className="step-text">{step.text}</span>
              {step.code ? <pre className="step-code"><code>{step.code}</code></pre> : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}
