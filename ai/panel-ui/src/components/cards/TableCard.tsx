import type { TableArgs } from '@shared'

import { TableIcon } from '../Icons'
import { Card } from './Card'

export function TableCard ({ args }: { args: TableArgs }) {
  return (
    <Card icon={<TableIcon />} title={args.title ?? 'Table'}>
      <div className="tbl-wrap">
        <table className="aic-tbl">
          <thead>
            <tr>{args.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr>
          </thead>
          <tbody>
            {args.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {args.columns.map((_column, cellIndex) => <td key={cellIndex}>{row[cellIndex] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
