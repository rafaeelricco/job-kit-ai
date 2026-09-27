# Tables (DataTable)

Every table follows one recipe: define `columns` as a **`ColumnsConfig`** (each a `ColumnDef` with a
`label` and a `sortFun`, `null` for unsortable), pick a **`columnOrder`**, and map your typed data to
**`rows`** of `{ key, value, contents }` — `contents` keyed exactly to `columns`. `DataTable` renders the
header, the sort affordance, and the empty state; it never reorders or pages rows itself — the host page
owns sorting (`comparator`), slicing a page, and rendering `DataTablePagination` below the table.

Write that mutates the collection: `./forms.md`. Host page: `./pages.md`.

## Audit

- Read `packages/frontend/src/components/ui/datatable.tsx` for the exported surface (`DataTable`, `ColumnDef`,
  `DataTablePagination`, `comparator`, `ColumnsConfig`, `SortState`).
- Read one existing table before editing — `DossierTable` (`packages/frontend/src/module/scout/components/dossier.tsx`:
  selection, row actions, column toggle, pagination) or `AnswerTable`
  (`packages/frontend/src/module/profile/components/answer.tsx`: plain, one page) — plus its `helpers/columns.ts` and
  host page.

Report the audit briefly:

```md
DataTable Audit:

- DataTable module path:
- Row type for this table:
- Sortable columns (sortFun) vs static (null):
- Default sort (SortState):
- Pagination or single page:
- Existing tables referenced:
```

## Canonical references (by role)

- **`@ui/datatable`** — `DataTable`, `ColumnDef`, `ColumnsConfig`, `SortState`, `comparator`,
  `DataTablePagination`. The whole public API.
- **`ColumnDef<T>`** — one column: `new ColumnDef({ label: ReactNode, sortFun: ((a: T, b: T) => number) |
null, align?: "left" | "right", className?: string })`. `className` reaches the header cell only —
  `align` reaches both.
- **`ColumnsConfig<T>`** — `{ readonly [key: string]: ColumnDef<T> }`; type the map with
  `satisfies ColumnsConfig<T>` so `contents` stays in sync.
- **`SortState`** — `{ sorting: "increasing" | "decreasing"; column: string } | { sorting: "unsorted";
column: null }`. `column` is a plain string, so pin a default with `satisfies ColumnId`.
- **`DataTableProps`** — `columns`, `columnOrder: readonly (keyof C)[]`, `rows`, `emptyMessage`, `sort`,
  `onSortChange`. All six required, and there is nothing else on the type — see Do/Do not.
- **`DataTablePagination`** — `page`, `pages`, `onPage`, optional `status`, and an all-or-nothing trio
  `sizes` / `size` / `onSize` (omit all three for no page-size menu).
- **`paginate`** — `@module/scout/helpers/select`, `paginate(rows, page, size)` returns
  `{ rows, page (clamped), pages }`. It is the only paginator today — import it from there, or move it to
  `@lib` once a second module needs pagination.

## Imports

```ts
import { ColumnDef, DataTable, DataTablePagination, comparator } from "@ui/datatable"
import { type ColumnsConfig, type SortState } from "@ui/datatable"
```

Paginating adds:

```ts
import { PAGE_SIZES, paginate } from "@module/scout/helpers/select"
import { type PageSize } from "@module/scout/helpers/select"
```

## 1. Defining columns

Columns live in `<module>/helpers/columns.ts` with their `sortFun`s and the default sort, so the page
(comparator) and the component (render) share one object:

```ts
const byQuestion = (a: Answer, b: Answer): number => a.question.localeCompare(b.question)
const byConfirmed = (a: Answer, b: Answer): number => a.confirmedAt.localeCompare(b.confirmedAt)

const ANSWER_COLUMNS = {
  question: new ColumnDef({ label: "Question", sortFun: byQuestion, className: "w-[38%]" }),
  answer: new ColumnDef({ label: "Answer", sortFun: null, className: "w-[38%]" }),
  scope: new ColumnDef({ label: "Scope", sortFun: null, className: "w-28" }),
  confirmedAt: new ColumnDef({ label: "Confirmed", sortFun: byConfirmed, className: "w-32" }),
} satisfies ColumnsConfig<Answer>

const ANSWER_ORDER = ["question", "answer", "scope", "confirmedAt"] as const

const DEFAULT_ANSWER_SORT: SortState = { sorting: "decreasing", column: "confirmedAt" }
```

Every `sortFun` reads ascending — `comparator` negates it for `"decreasing"`, so writing one descending
would flip on every other column. `className` sets widths on the header cell (`w-[38%]`, `w-28`, …);
`sortFun: null` marks a column unsortable, for static, selection, and action columns alike. Pin the
default sort's `column` with `satisfies ColumnId` (a bare `SortState` literal compiles even if the string
doesn't name a real column):

```ts
const DEFAULT_SORT: SortState = { sorting: "decreasing", column: "score" satisfies ColumnId }
```

## 2. Wiring rows

`contents` is keyed exactly to `columns`; `value` is the typed datum that `sortFun` and `onClick` receive:

```tsx
rows={rows.map((row) => ({
  key: row.id,
  value: row,
  contents: {
    question: <span className="block whitespace-normal">{row.question}</span>,
    answer:
      row.answered ?
        <span className="block whitespace-normal">{row.answer}</span>
      : <Badge variant="outline">Unanswered</Badge>,
    scope: <span className="text-muted-foreground">{row.scope ?? "—"}</span>,
    confirmedAt: <span className="font-mono text-muted-foreground">{row.confirmedAt}</span>,
  },
}))}
```

`TableCell` is `whitespace-nowrap` by default — prose cells opt back into wrapping on the cell content
itself (`<span className="block whitespace-normal">…</span>`), because a column `className` only reaches
the header. A row with `onClick` gets `tabIndex=0` and fires on click, Enter, or Space; `selected: boolean`
sets `aria-selected` and `data-state="selected"` for a selected row.

## 3. Column order

`columns` defines what a column _is_; `columnOrder` decides which render and in what order. Derive it from
a constant order tuple filtered by the visible set, so toggling columns never reshuffles them:

```ts
const visible = COLUMNS.filter((id) => props.columns.includes(id))
```

Selection and action columns wrap the derived order rather than joining it:

```tsx
columnOrder={["select", ...visible, "actions"]}
```

## 4. Sorting

Sorting is controlled — `DataTable` never reorders rows itself. A header click cycles the column through
new column → increasing → decreasing → unsorted, and emits the next `SortState` via `onSortChange`. The
page applies it with `comparator(columns, sort)`, which falls back to store order for an unsorted, unknown,
or unsortable column:

```tsx
const [sort, setSort] = useState<SortState>(DEFAULT_ANSWER_SORT)
// `slice()` first — `sort()` mutates, and `ordered` must not mutate `visible`.
const ordered = useMemo(() => visible.slice().sort(comparator(ANSWER_COLUMNS, sort)), [visible, sort])
```

Sort before paginating (§5) so a page slice reflects the current order, not the one before the last sort.

## 5. Pagination and empty state

Pagination is outside `DataTable`. The page owns `page` and `pageSize` state, sorts, then paginates, then
renders `DataTablePagination` below the table:

```tsx
const [page, setPage] = useState(1)
const [pageSize, setPageSize] = useState<PageSize>(PAGE_SIZES[0])
const ordered = useMemo(() => visible.slice().sort(comparator(DOSSIER_COLUMNS, sort)), [visible, sort])
const current = paginate(ordered, page, pageSize)
```

```tsx
<DataTablePagination
  page={current.page}
  pages={current.pages}
  onPage={setPage}
  sizes={PAGE_SIZES}
  size={pageSize}
  onSize={onPageSize}
/>
```

Reset `page` to `1` whenever the filter, sort, or page size changes — a stale page number otherwise strands
the caller past the end of a shrunk set. Omit `DataTablePagination` entirely when the set fits one page —
the answers page renders all 154 rows without it.

`emptyMessage` is a two-line node, not a single sentence:

```tsx
emptyMessage={
  <>
    <p className="text-sm font-medium text-foreground">No answers match</p>
    <p className="mt-1 text-sm text-muted-foreground">Clear a filter to widen the set.</p>
  </>
}
```

## 6. Rich cells and row actions

`contents` values are `ReactNode`, so cells can be JSX — badges, icons, tabular-nums numerics. Status cells
use `Badge` from `@ui/badge` (`default`, `secondary`, `destructive`, `success`, `outline`, `ghost`, `link`):

```tsx
<Badge variant="secondary">{row.status}</Badge>
```

Because a row with `onClick` also fires on Enter/Space, a control inside a clickable row must stop both the
click and the keydown, not just the click:

```tsx
function StopClick({ children }: { readonly children: ReactNode }) {
  return (
    <span
      className="flex items-center"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </span>
  )
}
```

Selection: a `select` column whose header is a select-all checkbox, `selected` on each row, and a per-row
checkbox wrapped in `StopClick`:

```tsx
select: new ColumnDef({
  className: "w-10",
  sortFun: null,
  label: <Checkbox checked={allSelected} onCheckedChange={onToggleAll} aria-label="Select all visible rows" />,
}),
```

```tsx
contents: {
  select: (
    <StopClick>
      <Checkbox checked={selected} onCheckedChange={() => onToggle(row.id)} aria-label={`Select ${row.name}`} />
    </StopClick>
  ),
  // ...
}
```

Row actions: an `actions` column rendering a `DropdownMenu` whose trigger is an icon-only ghost button,
wrapped in `StopClick`. Posting URLs come from the corpus, so pass them through `httpHref`
(`@module/scout/helpers/href`) and open only what it returns:

```tsx
actions: new ColumnDef({ label: "", sortFun: null, className: "w-10" }),
```

```tsx
<StopClick>
  <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
      <span className="sr-only">Open menu</span>
      <HugeiconsIcon icon={MoreHorizontalIcon} />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-52">
      {href === null ? null : (
        <DropdownMenuItem onClick={() => window.open(href, "_blank", "noopener,noreferrer")}>
          <HugeiconsIcon icon={LinkSquare02Icon} />
          Open posting
        </DropdownMenuItem>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
</StopClick>
```

Icons come from `import { HugeiconsIcon } from "@hugeicons/react"` plus a name from
`@hugeicons/core-free-icons`, used as `<HugeiconsIcon icon={X} />`. Reuse a name the app already uses where
one fits (`MoreHorizontalIcon`, `LinkSquare02Icon`, `Tick02Icon`, `Delete02Icon`); lucide is not installed.

## 7. Numeric columns

Project convention — see `packages/frontend/CONVENTIONS.md` → "Numeric Data in Tables" for the full rule, and
`packages/frontend/CLAUDE.md`.

- Format counts with **`toLocaleString()`** and nothing else — no `toFixed`, no `Intl.NumberFormat`, no
  template literal. The app has no money, hours, or duration formatter module.
- Set **`align: "right"`** on the `ColumnDef` and pair it with **`tabular-nums`** on the cell.
- Digit-shaped **identifiers** (a posting id, a source slug) stay left-aligned — right-align only what
  could sensibly be summed.
- `sortFun` reads the underlying number, never the formatted string.
- An absent figure renders as an em dash (`—`, via `factText`), and an unscored factor renders as
  `no signal` — never `0`. "No value" is not a real zero.
- Drop unit suffixes the header already carries — a count column titled "Applications" renders `12`, not
  `12 applications`.
- **Exempt:** composite or interactive cells (a score badge, a status dropdown) have no single right edge —
  keep the figure `tabular-nums` and leave the column's default alignment.

```tsx
applications: new ColumnDef({ label: "Applications", sortFun: byApplications, align: "right" }),
// contents:
applications: <span className="tabular-nums">{row.applications.toLocaleString()}</span>,
```

## 8. Detail tables (carve-out)

`DataTable` is for a collection the user sorts, filters, selects, or pages. A single record's label/value
fields, a points breakdown with a total row, or a short read-only log inside a sheet uses the `@ui/table`
primitives directly (`Table`, `TableBody`, `TableRow`, `TableCell`, plus `TableHeader`/`TableHead` when it
has a header) instead — see the Score, Facts, and Logs folds of `DossierSheet`
(`packages/frontend/src/module/scout/components/dossier.tsx`). The numeric and `font-mono` rules from §7 and
`packages/frontend/CLAUDE.md` still apply there.

## Do / Do not

- Do: keep `contents` keys identical to `columns` and to `columnOrder`.
- Do: set `sortFun: null` for select/actions/static columns.
- Do: sort off the typed `value`, ascending, never off the rendered `contents` node.
- Do: own `page`/`pageSize` state in the page, sort with `comparator`, then `paginate`, then render
  `DataTablePagination` below the table.
- Do: reset `page` to `1` on filter, sort, and page-size change.
- Do: stop both click and keydown (`StopClick`) on a control inside a clickable row.
- Do: right-align numeric quantities (`align: "right"` + `tabular-nums`) per §7.
- Do not: pass `pagination`, `defaultSort`, or `isTableFixed` to `DataTable` — none of these props exist.
- Do not: hand-roll a `<table>` for a sortable or pageable collection (a genuine detail table per §8 is
  fine).
- Do not: import the table pieces through `@/` or a relative path — `packages/frontend/CLAUDE.md` requires `@ui/datatable`.
- Do not: format counts with anything but `toLocaleString()`.

## Examples

Three self-contained snippets against one small domain type:

```ts
type Application = {
  readonly id: string
  readonly company: string
  readonly role: string
  readonly appliedOn: string // ISO day
  readonly responses: number
  readonly status: "sent" | "interview" | "rejected"
  readonly url: string
}
```

### 1. Sorted table, one page

```tsx
import { useMemo, useState } from "react"
import { ColumnDef, DataTable, comparator } from "@ui/datatable"
import { type ColumnsConfig, type SortState } from "@ui/datatable"
import { Badge } from "@ui/badge"

const byCompany = (a: Application, b: Application) => a.company.localeCompare(b.company)
const byAppliedOn = (a: Application, b: Application) => a.appliedOn.localeCompare(b.appliedOn)
const byResponses = (a: Application, b: Application) => a.responses - b.responses

const APPLICATION_COLUMNS = {
  company: new ColumnDef({ label: "Company", sortFun: byCompany }),
  appliedOn: new ColumnDef({ label: "Applied", sortFun: byAppliedOn }),
  responses: new ColumnDef({ label: "Responses", sortFun: byResponses, align: "right" }),
  status: new ColumnDef({ label: "Status", sortFun: null }),
} satisfies ColumnsConfig<Application>

const DEFAULT_APPLICATION_SORT: SortState = {
  sorting: "decreasing",
  column: "appliedOn" satisfies keyof typeof APPLICATION_COLUMNS,
}

function ApplicationTable({ rows }: { readonly rows: readonly Application[] }) {
  const [sort, setSort] = useState<SortState>(DEFAULT_APPLICATION_SORT)
  const ordered = useMemo(() => rows.slice().sort(comparator(APPLICATION_COLUMNS, sort)), [rows, sort])

  return (
    <DataTable
      columns={APPLICATION_COLUMNS}
      columnOrder={["company", "appliedOn", "responses", "status"]}
      sort={sort}
      onSortChange={setSort}
      emptyMessage={
        <>
          <p className="text-sm font-medium text-foreground">No applications match</p>
          <p className="mt-1 text-sm text-muted-foreground">Clear a filter to widen the set.</p>
        </>
      }
      rows={ordered.map((row) => ({
        key: row.id,
        value: row,
        contents: {
          company: <span className="font-medium text-foreground">{row.company}</span>,
          appliedOn: <span className="font-mono text-muted-foreground">{row.appliedOn}</span>,
          responses: <span className="tabular-nums">{row.responses.toLocaleString()}</span>,
          status: <Badge variant={row.status === "interview" ? "success" : "secondary"}>{row.status}</Badge>,
        },
      }))}
    />
  )
}
```

### 2. Paginated table with selection and row actions

Builds on `Application`, `APPLICATION_COLUMNS`, and `DEFAULT_APPLICATION_SORT` from Example 1.

```tsx
import { useMemo, useState, type ReactNode } from "react"
import { MoreHorizontalIcon, LinkSquare02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { ColumnDef, DataTable, DataTablePagination, comparator } from "@ui/datatable"
import { type ColumnsConfig, type SortState } from "@ui/datatable"
import { Badge } from "@ui/badge"
import { Button } from "@ui/button"
import { Checkbox } from "@ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@ui/dropdown-menu"
import { httpHref } from "@module/scout/helpers/href"
import { paginate, PAGE_SIZES } from "@module/scout/helpers/select"
import { type PageSize } from "@module/scout/helpers/select"

function StopClick({ children }: { readonly children: ReactNode }) {
  return (
    <span
      className="flex items-center"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </span>
  )
}

function RowActions({ row }: { readonly row: Application }) {
  const href = httpHref(row.url)
  return (
    <StopClick>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
          <span className="sr-only">Open menu</span>
          <HugeiconsIcon icon={MoreHorizontalIcon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {href === null ? null : (
            <DropdownMenuItem onClick={() => window.open(href, "_blank", "noopener,noreferrer")}>
              <HugeiconsIcon icon={LinkSquare02Icon} />
              Open posting
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </StopClick>
  )
}

function ApplicationTableWithActions(props: {
  readonly rows: readonly Application[]
  readonly onOpen: (row: Application) => void
}) {
  const [sort, setSort] = useState<SortState>(DEFAULT_APPLICATION_SORT)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(PAGE_SIZES[0])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const ordered = useMemo(() => props.rows.slice().sort(comparator(APPLICATION_COLUMNS, sort)), [props.rows, sort])
  const current = paginate(ordered, page, pageSize)
  const allSelected = current.rows.length > 0 && current.rows.every((row) => selected.has(row.id))

  const onSort = (next: SortState) => {
    setSort(next)
    setPage(1)
  }

  const onPageSize = (next: PageSize) => {
    setPageSize(next)
    setPage(1)
  }

  const onToggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onToggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const row of current.rows) {
        if (allSelected) next.delete(row.id)
        else next.add(row.id)
      }
      return next
    })

  const columns = {
    select: new ColumnDef({
      className: "w-10",
      sortFun: null,
      label: <Checkbox checked={allSelected} onCheckedChange={onToggleAll} aria-label="Select all visible rows" />,
    }),
    ...APPLICATION_COLUMNS,
    actions: new ColumnDef({ label: "", sortFun: null, className: "w-10" }),
  } satisfies ColumnsConfig<Application>

  return (
    <>
      <DataTable
        columns={columns}
        columnOrder={["select", "company", "appliedOn", "responses", "status", "actions"]}
        sort={sort}
        onSortChange={onSort}
        emptyMessage="No applications"
        rows={current.rows.map((row) => ({
          key: row.id,
          value: row,
          selected: selected.has(row.id),
          onClick: () => props.onOpen(row),
          contents: {
            select: (
              <StopClick>
                <Checkbox
                  checked={selected.has(row.id)}
                  onCheckedChange={() => onToggle(row.id)}
                  aria-label={`Select ${row.company}`}
                />
              </StopClick>
            ),
            company: <span className="font-medium text-foreground">{row.company}</span>,
            appliedOn: <span className="font-mono text-muted-foreground">{row.appliedOn}</span>,
            responses: <span className="tabular-nums">{row.responses.toLocaleString()}</span>,
            status: <Badge variant={row.status === "interview" ? "success" : "secondary"}>{row.status}</Badge>,
            actions: <RowActions row={row} />,
          },
        }))}
      />
      <DataTablePagination
        page={current.page}
        pages={current.pages}
        onPage={setPage}
        sizes={PAGE_SIZES}
        size={pageSize}
        onSize={onPageSize}
      />
    </>
  )
}
```

### 3. Conditional columns

Builds on `Application`, `APPLICATION_COLUMNS`, and `DEFAULT_APPLICATION_SORT` from Example 1.

```tsx
import { useMemo, useState } from "react"
import { DataTable, comparator } from "@ui/datatable"
import { type SortState } from "@ui/datatable"
import { Badge } from "@ui/badge"
import { Button } from "@ui/button"
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@ui/dropdown-menu"

const APPLICATION_COLUMN_IDS = ["company", "appliedOn", "responses", "status"] as const

type ApplicationColumnId = (typeof APPLICATION_COLUMN_IDS)[number]

function ConditionalApplicationTable(props: { readonly rows: readonly Application[] }) {
  const [sort, setSort] = useState<SortState>(DEFAULT_APPLICATION_SORT)
  const [visible, setVisible] = useState<readonly ApplicationColumnId[]>(APPLICATION_COLUMN_IDS)

  const ordered = useMemo(() => props.rows.slice().sort(comparator(APPLICATION_COLUMNS, sort)), [props.rows, sort])
  const columnOrder = APPLICATION_COLUMN_IDS.filter((id) => visible.includes(id))

  const onToggleColumn = (id: ApplicationColumnId) =>
    setVisible((prev) => (prev.includes(id) ? prev.filter((one) => one !== id) : [...prev, id]))

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>Columns</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {APPLICATION_COLUMN_IDS.map((id) => (
            <DropdownMenuCheckboxItem
              key={id}
              checked={visible.includes(id)}
              onCheckedChange={() => onToggleColumn(id)}
            >
              {APPLICATION_COLUMNS[id].values.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DataTable
        columns={APPLICATION_COLUMNS}
        columnOrder={columnOrder}
        sort={sort}
        onSortChange={setSort}
        emptyMessage="No applications"
        rows={ordered.map((row) => ({
          key: row.id,
          value: row,
          contents: {
            company: <span className="font-medium text-foreground">{row.company}</span>,
            appliedOn: <span className="font-mono text-muted-foreground">{row.appliedOn}</span>,
            responses: <span className="tabular-nums">{row.responses.toLocaleString()}</span>,
            status: <Badge variant={row.status === "interview" ? "success" : "secondary"}>{row.status}</Badge>,
          },
        }))}
      />
    </>
  )
}
```
