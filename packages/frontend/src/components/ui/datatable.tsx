export { ColumnDef, DataTable, DataTablePagination, comparator, type ColumnsConfig, type SortState }

import * as React from "react"

import { ArrowDown01Icon, ArrowUpDownIcon, SortingDownIcon, SortingUpIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { type Key, type KeyboardEvent, type ReactNode } from "react"
import { Button } from "@ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/dropdown-menu"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@ui/pagination"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/table"
import { cn } from "@components/utils"

type SortFun<T> = (a: T, b: T) => number

// `sortFun: null` marks a column unsortable — selection and action columns.
type ColumnSpec<T> = {
  readonly label: ReactNode
  readonly sortFun: SortFun<T> | null
  readonly align?: "left" | "right"
  readonly className?: string
}

// A class, not a plain object type: `new ColumnDef({...})` pins T from `sortFun`
// at the definition site, and the `values` box stops a bare literal passing
// structurally where a column is expected.
class ColumnDef<T> {
  readonly values: ColumnSpec<T>

  constructor(values: ColumnSpec<T>) {
    this.values = values
  }
}

type ColumnsConfig<T> = { readonly [key: string]: ColumnDef<T> }

type Row<T, C extends ColumnsConfig<T>> = {
  readonly key: Key
  readonly value: T
  readonly className?: string
  readonly selected?: boolean
  readonly contents: { readonly [K in keyof C]: ReactNode }
  readonly onClick?: (value: T) => void
}

// Deliberately not generic over the columns map. Keying `column` to `keyof C`
// makes `onSortChange` contravariant, so a handler typed over the domain
// columns stops being assignable once `select`/`actions` widen `C`.
type SortState =
  | { readonly sorting: "increasing"; readonly column: string }
  | { readonly sorting: "decreasing"; readonly column: string }
  | { readonly sorting: "unsorted"; readonly column: null }

type DataTableProps<T, C extends ColumnsConfig<T>> = {
  readonly columns: C
  readonly columnOrder: readonly (keyof C)[]
  readonly rows: readonly Row<T, C>[]
  readonly emptyMessage: ReactNode
  readonly sort: SortState
  readonly onSortChange: (next: SortState) => void
}

const keepOrder: SortFun<unknown> = () => 0

// The caller applies this — DataTable renders the header state and emits the
// next one, it never reorders rows itself. An unknown or unsortable column
// degrades to store order rather than throwing.
function comparator<T>(columns: ColumnsConfig<T>, sort: SortState): SortFun<T> {
  if (sort.sorting === "unsorted") return keepOrder
  const sortFun = columns[sort.column]?.values.sortFun
  if (sortFun === undefined || sortFun === null) return keepOrder
  return sort.sorting === "increasing" ? sortFun : (a, b) => -sortFun(a, b)
}

// A fresh column starts ascending; the active one steps to descending, then off.
function cycle(current: SortState, column: string): SortState {
  if (current.column !== column) return { sorting: "increasing", column }
  if (current.sorting === "increasing") return { sorting: "decreasing", column }
  return { sorting: "unsorted", column: null }
}

type ColumnSort = "none" | "increasing" | "decreasing"

const ariaSort = (state: ColumnSort | null) =>
  state === null ? undefined
  : state === "none" ? ("none" as const)
  : state === "increasing" ? ("ascending" as const)
  : ("descending" as const)

function SortableHeader(props: {
  readonly label: ReactNode
  readonly state: ColumnSort | null
  readonly onSort: () => void
}): ReactNode {
  if (props.state === null) return props.label
  return (
    <div className="inline-flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0">
      {props.label}
      <button type="button" aria-label="Toggle sort" className="inline-flex cursor-pointer" onClick={props.onSort}>
        {props.state === "increasing" ?
          <HugeiconsIcon icon={SortingUpIcon} className="text-foreground" />
        : props.state === "decreasing" ?
          <HugeiconsIcon icon={SortingDownIcon} className="text-foreground" />
        : <HugeiconsIcon icon={ArrowUpDownIcon} className="text-muted-foreground hover:text-foreground" />}
      </button>
    </div>
  )
}

function DataTable<T, C extends ColumnsConfig<T>>(props: DataTableProps<T, C>) {
  const { columnOrder, columns, emptyMessage, onSortChange, rows, sort } = props

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: Row<T, C>) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    row.onClick?.(row.value)
  }

  return (
    <div className="overflow-hidden border">
      <Table>
        <TableHeader>
          <TableRow>
            {columnOrder.map((id) => {
              const column = columns[id]?.values
              if (column === undefined) return null
              const state: ColumnSort | null =
                column.sortFun === null ? null
                : sort.column !== String(id) ? "none"
                : sort.sorting === "increasing" ? "increasing"
                : "decreasing"
              return (
                <TableHead
                  key={String(id)}
                  aria-sort={ariaSort(state)}
                  className={cn(column.align === "right" && "text-right", column.className)}
                >
                  <SortableHeader
                    label={column.label}
                    state={state}
                    onSort={() => onSortChange(cycle(sort, String(id)))}
                  />
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ?
            <TableRow>
              <TableCell colSpan={columnOrder.length} className="h-32 text-center whitespace-normal">
                {emptyMessage}
              </TableCell>
            </TableRow>
          : rows.map((row) => (
              <TableRow
                key={row.key}
                tabIndex={row.onClick === undefined ? undefined : 0}
                aria-selected={row.selected}
                data-state={row.selected === true ? "selected" : undefined}
                onClick={() => row.onClick?.(row.value)}
                onKeyDown={(event) => onRowKeyDown(event, row)}
                className={cn(
                  row.onClick !== undefined &&
                    "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  row.className
                )}
              >
                {columnOrder.map((id) => (
                  <TableCell key={String(id)} className={cn(columns[id]?.values.align === "right" && "text-right")}>
                    {row.contents[id]}
                  </TableCell>
                ))}
              </TableRow>
            ))
          }
        </TableBody>
      </Table>
    </div>
  )
}

// Page numbers to render, `null` marking an elided run. Caps the control at
// seven slots so it does not widen as the dossier count grows.
function pageWindow(page: number, pages: number): readonly (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const start = Math.min(Math.max(page - 1, 2), pages - 3)
  const end = start + 2
  return [1, ...(start > 2 ? [null] : []), start, start + 1, end, ...(end < pages - 1 ? [null] : []), pages]
}

// Menu radio values are strings; `find` returns `S | undefined` — no assertion.
function sizeFromToken<S extends number>(sizes: readonly S[], token: string): S | undefined {
  return sizes.find((s) => s === Number(token))
}

type SizeControls<S extends number> =
  | {
      readonly sizes: readonly S[]
      readonly size: S
      readonly onSize: (next: S) => void
    }
  | {
      readonly sizes?: undefined
      readonly size?: undefined
      readonly onSize?: undefined
    }

function DataTablePagination<S extends number>(
  props: {
    readonly page: number
    readonly pages: number
    readonly onPage: (next: number) => void
    readonly status?: ReactNode
  } & SizeControls<S>
) {
  const atFirst = props.page <= 1
  const atLast = props.page >= props.pages
  return (
    <div className="flex items-center gap-2">
      {props.status === undefined ? null : <div className="flex-1 text-sm text-muted-foreground">{props.status}</div>}
      <div className="flex w-full items-center justify-between gap-2">
        {props.sizes ?
          <React.Fragment>
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground">Rows per page</p>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />} aria-label="Page size">
                  {props.size}
                  <HugeiconsIcon icon={ArrowDown01Icon} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Page size</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup
                      value={String(props.size)}
                      onValueChange={(next) => {
                        const parsed = sizeFromToken(props.sizes, String(next))
                        if (parsed !== undefined) props.onSize(parsed)
                      }}
                    >
                      {props.sizes.map((n) => (
                        <DropdownMenuRadioItem key={n} value={String(n)}>
                          {n}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </React.Fragment>
        : null}
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                aria-disabled={atFirst}
                className={cn(atFirst && "pointer-events-none opacity-50")}
                onClick={() => props.onPage(props.page - 1)}
              />
            </PaginationItem>
            {pageWindow(props.page, props.pages).map((n, i) =>
              n === null ?
                <PaginationItem key={`gap-${i}`}>
                  <PaginationEllipsis />
                </PaginationItem>
              : <PaginationItem key={n}>
                  <PaginationLink isActive={n === props.page} onClick={() => props.onPage(n)}>
                    {n}
                  </PaginationLink>
                </PaginationItem>
            )}
            <PaginationItem>
              <PaginationNext
                aria-disabled={atLast}
                className={cn(atLast && "pointer-events-none opacity-50")}
                onClick={() => props.onPage(props.page + 1)}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  )
}
