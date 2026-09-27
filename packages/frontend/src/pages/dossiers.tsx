export default DossiersPage

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Briefcase01Icon } from "@hugeicons/core-free-icons"
import { DataTablePagination, comparator } from "@ui/datatable"
import { type SortState } from "@ui/datatable"
import { DossierCards, DossierSheet, DossierTable } from "@module/scout/components/dossier"
import { FilterBar } from "@module/scout/components/filter-bar"
import { Gaps } from "@module/scout/components/gaps"
import { OverviewCards } from "@module/scout/components/overview-cards"
import { SelectionBar } from "@module/scout/components/selection-bar"
import { StoreGate } from "@module/scout/components/store-gate"
import { type Ready } from "@module/scout/components/store-gate"
import { DEFAULT_COLUMNS, DEFAULT_SORT, DOSSIER_COLUMNS } from "@module/scout/helpers/columns"
import { type ColumnId, type View } from "@module/scout/helpers/columns"
import { PAGE_SIZES, matches, paginate, summarize, tallySources } from "@module/scout/helpers/select"
import { type Filter, type PageSize } from "@module/scout/helpers/select"
import { readFilter, writeFilter } from "@module/scout/helpers/filter-store"
import { assertNever } from "@module/scout/result"
import { type Result } from "@module/scout/result"
import { type TrashOpError, type Trashed } from "@module/scout/types"

type TrashFn = (files: readonly string[]) => Promise<Result<Trashed, TrashOpError>>

function DossiersPage() {
  return (
    <StoreGate title="Dossiers" Icon={Briefcase01Icon}>
      {(store, actions) => <Surface store={store} trash={actions.trash} />}
    </StoreGate>
  )
}

function Surface({ store, trash: trashFiles }: { readonly store: Ready; readonly trash: TrashFn }) {
  const [filter, setFilter] = useState<Filter>(readFilter)
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<PageSize>(PAGE_SIZES[0])
  const [columns, setColumns] = useState<readonly ColumnId[]>(DEFAULT_COLUMNS)
  const [view, setView] = useState<View>("table")
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)

  const visible = useMemo(() => store.dossiers.filter(matches(filter)), [store.dossiers, filter])
  const ordered = useMemo(() => visible.slice().sort(comparator(DOSSIER_COLUMNS, sort)), [visible, sort])
  const current = paginate(ordered, page, pageSize)
  // Store-wide, not filter-scoped: these are a standing overview.
  const summary = useMemo(() => summarize(store.dossiers), [store.dossiers])
  const sources = useMemo(() => tallySources(store.dossiers), [store.dossiers])

  const selectedRows = visible.filter((d) => selected.has(d.file))
  const openDossier = store.dossiers.find((d) => d.file === open) ?? null

  const onFilter = (next: Filter) => {
    setFilter(next)
    writeFilter(next)
    setPage(1)
  }

  const onSort = (next: SortState) => {
    setSort(next)
    setPage(1)
  }

  const onPageSize = (next: PageSize) => {
    setPageSize(next)
    setPage(1)
  }

  const onToggle = (file: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })

  const onToggleAll = () =>
    setSelected((prev) => {
      const all = current.rows.every((row) => prev.has(row.file))
      const next = new Set(prev)
      for (const row of current.rows) {
        if (all) next.delete(row.file)
        else next.add(row.file)
      }
      return next
    })

  // One call for both callers: the toolbar sends the selection, the row menu
  // sends a single file. Reload is owned by useStore.trash after a successful move.
  const trash = (files: readonly string[]) => {
    void trashFiles(files).then((result) => {
      if (result.kind === "err") {
        toast.error(describeTrashError(result.error))
        return
      }
      const { moved, failed } = result.value
      const noun = moved.length === 1 ? "dossier" : "dossiers"
      toast.success(`Moved ${moved.length} ${noun} to scout/jobs/.trash`)
      for (const failure of failed) {
        toast.error(`${failure.file}: ${failure.reason}`)
      }
      setSelected(new Set())
    })
  }

  const onDelete = () => trash(selectedRows.map((row) => row.file))
  const onDeleteOne = (file: string) => trash([file])

  return (
    <>
      <OverviewCards summary={summary} />

      <FilterBar
        filter={filter}
        onFilter={onFilter}
        view={view}
        onView={setView}
        columns={columns}
        onColumns={setColumns}
        sources={sources}
      />

      {view === "table" ?
        <DossierTable
          rows={current.rows}
          columns={columns}
          sort={sort}
          onSort={onSort}
          selected={selected}
          onToggle={onToggle}
          onToggleAll={onToggleAll}
          onOpen={setOpen}
          onDelete={onDeleteOne}
        />
      : <DossierCards rows={current.rows} selected={selected} onToggle={onToggle} onOpen={setOpen} />}

      <DataTablePagination
        page={current.page}
        pages={current.pages}
        onPage={setPage}
        sizes={PAGE_SIZES}
        size={pageSize}
        onSize={onPageSize}
      />

      <Gaps gaps={store.gaps} />

      <footer className="font-mono text-xs text-muted-foreground">
        {store.dossiers.length.toLocaleString()} dossiers · {store.gaps.length.toLocaleString()} gaps · view of{" "}
        {store.label}
        /scout/jobs · folder picker · generated {store.generatedAt}
      </footer>

      <SelectionBar rows={selectedRows} onDelete={onDelete} onClear={() => setSelected(new Set())} />

      <DossierSheet dossier={openDossier} skills={store.skills} onClose={() => setOpen(null)} />
    </>
  )
}

function describeTrashError(error: TrashOpError): string {
  switch (error.kind) {
    case "not-allowed":
      return "Folder write permission was denied"
    case "stale":
      return "Saved folder is gone — choose it again"
    case "jobs-missing":
      return "scout/jobs is missing in the chosen folder"
    case "failed":
      return error.detail
    default:
      return assertNever(error)
  }
}
