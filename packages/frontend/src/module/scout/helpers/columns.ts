export { COLUMNS, DEFAULT_COLUMNS, DEFAULT_SORT, DOSSIER_COLUMNS, VIEWS, columnLabel, isView, type ColumnId, type View }

import { ColumnDef } from "@ui/datatable"
import { type ColumnsConfig, type SortState } from "@ui/datatable"
import { byScore, byStatus, bySource } from "@module/scout/helpers/select"
import { type Dossier } from "@module/scout/types"

const COLUMNS = ["score", "company", "location", "salary", "source", "status"] as const

type ColumnId = (typeof COLUMNS)[number]

// Everything on by default; the dropdown only ever takes columns away.
const DEFAULT_COLUMNS: readonly ColumnId[] = COLUMNS

const LABELS: Readonly<Record<ColumnId, string>> = {
  score: "Score",
  company: "Company and role",
  location: "Location",
  salary: "Salary",
  source: "Source",
  status: "Status",
}

const columnLabel = (id: ColumnId): string => LABELS[id]

// Order rules live on the column now; `sortFun: null` is display-only.
// Ascending is the natural direction of each comparator — DataTable negates for
// descending.
const DOSSIER_COLUMNS = {
  score: new ColumnDef({ label: LABELS.score, sortFun: byScore }),
  company: new ColumnDef({ label: LABELS.company, sortFun: null }),
  location: new ColumnDef({ label: LABELS.location, sortFun: null }),
  salary: new ColumnDef({ label: LABELS.salary, sortFun: null }),
  source: new ColumnDef({ label: LABELS.source, sortFun: bySource }),
  status: new ColumnDef({ label: LABELS.status, sortFun: byStatus }),
} satisfies ColumnsConfig<Dossier>

// Same landing order as before: highest score first. `satisfies ColumnId` is
// what catches a typo here, since SortState.column is a plain string.
const DEFAULT_SORT: SortState = {
  sorting: "decreasing",
  column: "score" satisfies ColumnId,
}

const VIEWS = ["table", "cards"] as const

type View = (typeof VIEWS)[number]

const isView = (raw: string): raw is View => (VIEWS as readonly string[]).includes(raw)
