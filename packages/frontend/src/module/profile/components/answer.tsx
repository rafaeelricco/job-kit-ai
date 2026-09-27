export { AnswerTable }

import { Badge } from "@ui/badge"
import { DataTable } from "@ui/datatable"
import { type SortState } from "@ui/datatable"
import { ANSWER_COLUMNS, ANSWER_ORDER } from "@module/profile/helpers/columns"
import { type Answer } from "@module/profile/types"

// 136 of the 154 rows are empty by design — they are the backlog job-apply
// seeds — so "Unanswered" is a first-class state, not a filtered-out edge case.
function AnswerTable({
  rows,
  sort,
  onSort,
}: {
  readonly rows: readonly Answer[]
  readonly sort: SortState
  readonly onSort: (next: SortState) => void
}) {
  return (
    <DataTable
      columns={ANSWER_COLUMNS}
      columnOrder={[...ANSWER_ORDER]}
      sort={sort}
      onSortChange={onSort}
      emptyMessage={
        <>
          <p className="text-sm font-medium text-foreground">No answers match</p>
          <p className="mt-1 text-sm text-muted-foreground">Clear a filter to widen the set.</p>
        </>
      }
      rows={rows.map((row) => ({
        key: row.id,
        value: row,
        contents: {
          // TableCell is whitespace-nowrap by default, so the prose columns opt
          // back into wrapping on the cell itself — a column className only
          // reaches the header.
          question: <span className="block whitespace-normal">{row.question}</span>,
          answer:
            row.answered ?
              <span className="block whitespace-normal">{row.answer}</span>
            : <Badge variant="outline">Unanswered</Badge>,
          scope: <span className="text-muted-foreground">{row.scope ?? "—"}</span>,
          confirmedAt: <span className="text-muted-foreground tabular-nums">{row.confirmedAt}</span>,
        },
      }))}
    />
  )
}
