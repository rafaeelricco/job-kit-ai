export { ANSWER_COLUMNS, ANSWER_ORDER, DEFAULT_ANSWER_SORT, byConfirmed, byQuestion }

import { ColumnDef } from "@ui/datatable"
import { type ColumnsConfig, type SortState } from "@ui/datatable"
import { type Answer } from "@module/profile/types"

const byQuestion = (a: Answer, b: Answer): number => a.question.localeCompare(b.question)

// confirmed_at is an ISO day, so a lexical compare is a date compare.
const byConfirmed = (a: Answer, b: Answer): number => a.confirmedAt.localeCompare(b.confirmedAt)

const ANSWER_COLUMNS = {
  // Question and answer are the prose columns and take the width; the two
  // metadata columns are pinned narrow so neither can push them off-screen.
  question: new ColumnDef({ label: "Question", sortFun: byQuestion, className: "w-[38%]" }),
  answer: new ColumnDef({ label: "Answer", sortFun: null, className: "w-[38%]" }),
  scope: new ColumnDef({ label: "Scope", sortFun: null, className: "w-28" }),
  confirmedAt: new ColumnDef({ label: "Confirmed", sortFun: byConfirmed, className: "w-32" }),
} satisfies ColumnsConfig<Answer>

const ANSWER_ORDER = ["question", "answer", "scope", "confirmedAt"] as const

const DEFAULT_ANSWER_SORT: SortState = { sorting: "decreasing", column: "confirmedAt" }
