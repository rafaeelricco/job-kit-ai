export { FilterBar, type FilterBarProps }

import {
  ArrowDown01Icon,
  Calendar01Icon,
  Cancel01Icon,
  FilterIcon,
  GridViewIcon,
  RowsThreeIcon,
  Search01Icon,
  UnavailableIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { type DateRange } from "react-day-picker"
import { Badge } from "@ui/badge"
import { Button } from "@ui/button"
import { Calendar } from "@ui/calendar"
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@ui/command"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ui/dropdown-menu"
import { Input } from "@ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@ui/popover"
import { Tabs, TabsList, TabsTrigger } from "@ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@ui/toggle-group"
import { type ColumnId, type View } from "@module/scout/helpers/columns"
import { COLUMNS, VIEWS, columnLabel, isView } from "@module/scout/helpers/columns"
import {
  type DayRange,
  type Filter,
  type PostingKind,
  type ScoreBand,
  type Segment,
  type SourceRow,
} from "@module/scout/helpers/select"
import {
  EMPTY_DAYS,
  POSTINGS,
  POSTING_LABELS,
  SCORE_BANDS,
  SCORE_BAND_LABELS,
  SEGMENTS,
  cycleSource,
  dateOf,
  isoOf,
  sourceState,
  todayIso,
} from "@module/scout/helpers/select"
import { type Bucket, type Channel, type Lifecycle } from "@module/scout/types"
import { BUCKETS, CHANNELS, LIFECYCLES } from "@module/scout/types"

type FilterBarProps = {
  readonly filter: Filter
  readonly onFilter: (next: Filter) => void
  readonly view: View
  readonly onView: (next: View) => void
  readonly columns: readonly ColumnId[]
  readonly onColumns: (next: readonly ColumnId[]) => void
  readonly sources: readonly SourceRow[]
}

const SEGMENT_LABELS: Readonly<Record<Segment, string>> = {
  all: "All",
  new: "New",
  applied: "Applied",
  dead: "Dead",
}

const VIEW_LABELS: Readonly<Record<View, string>> = {
  table: "Table",
  cards: "Cards",
}

// A range whose ends are the same day is a day, and one of those days has a name.
function foundLabel(range: DayRange): string {
  const { from, to } = range
  if (from !== null && from === to) return from === todayIso() ? "today" : from
  if (from !== null && to !== null) return `${from} → ${to}`
  return from !== null ? `since ${from}` : `until ${to}`
}

const isSegment = (raw: unknown): raw is Segment =>
  typeof raw === "string" && (SEGMENTS as readonly string[]).includes(raw)

// Never mutates: the parent still holds the array we were handed.
function toggled<T>(chosen: readonly T[], value: T): readonly T[] {
  return chosen.includes(value) ? chosen.filter((one) => one !== value) : [...chosen, value]
}

// A removable facet value, flattened so the chip row does not branch per facet.
type Chip = {
  readonly key: string
  readonly label: string
  readonly remove: () => void
}

function FilterBar(props: FilterBarProps) {
  const { columns, filter, onColumns, onFilter, onView, sources, view } = props

  const setBuckets = (value: Bucket) => onFilter({ ...filter, buckets: toggled(filter.buckets, value) })
  const setChannels = (value: Channel) => onFilter({ ...filter, channels: toggled(filter.channels, value) })
  const setPostings = (value: PostingKind) => onFilter({ ...filter, postings: toggled(filter.postings, value) })
  const setStatuses = (value: Lifecycle) => onFilter({ ...filter, statuses: toggled(filter.statuses, value) })
  const setBands = (value: ScoreBand) => onFilter({ ...filter, bands: toggled(filter.bands, value) })
  const setSource = (value: string) => onFilter(cycleSource(filter, value))
  const setFound = (next: DayRange) => onFilter({ ...filter, found: next })

  // A picker range is undefined when nothing is chosen, and `to` is undefined
  // between the first and second click.
  const foundRange: DateRange | undefined =
    filter.found.from === null ?
      undefined
    : { from: dateOf(filter.found.from), to: filter.found.to === null ? undefined : dateOf(filter.found.to) }

  // Rebuilt from COLUMNS so re-adding a column restores its table position.
  const toggleColumn = (id: ColumnId) => {
    const next =
      columns.includes(id) ?
        columns.filter((one) => one !== id)
      : COLUMNS.filter((one) => one === id || columns.includes(one))
    if (next.length === 0) return
    onColumns(next)
  }

  const chips: readonly Chip[] = [
    ...filter.buckets.map((value) => ({
      key: `bucket:${value}`,
      label: `Route: ${value}`,
      remove: () => setBuckets(value),
    })),
    ...filter.channels.map((value) => ({
      key: `channel:${value}`,
      label: `Channel: ${value}`,
      remove: () => setChannels(value),
    })),
    ...filter.postings.map((value) => ({
      key: `posting:${value}`,
      label: `Posting: ${POSTING_LABELS[value]}`,
      remove: () => setPostings(value),
    })),
    ...filter.statuses.map((value) => ({
      key: `status:${value}`,
      label: `Status: ${value}`,
      remove: () => setStatuses(value),
    })),
    ...filter.bands.map((value) => ({
      key: `band:${value}`,
      label: `Score: ${SCORE_BAND_LABELS[value]}`,
      remove: () => setBands(value),
    })),
    ...filter.sources.map((value) => ({
      key: `source:${value}`,
      label: `Source: ${value}`,
      // Removing has to clear the state, not advance the cycle — from "only"
      // one more click would exclude, which is not what an × means.
      remove: () => onFilter({ ...filter, sources: filter.sources.filter((one) => one !== value) }),
    })),
    ...filter.excluded.map((value) => ({
      key: `excluded:${value}`,
      label: `Not: ${value}`,
      remove: () => onFilter({ ...filter, excluded: filter.excluded.filter((one) => one !== value) }),
    })),
    ...(filter.found.from === null && filter.found.to === null ?
      []
    : [{ key: "found", label: `Found: ${foundLabel(filter.found)}`, remove: () => setFound(EMPTY_DAYS) }]),
  ]

  const clearAll = () =>
    onFilter({
      ...filter,
      bands: [],
      buckets: [],
      channels: [],
      postings: [],
      statuses: [],
      sources: [],
      excluded: [],
      found: EMPTY_DAYS,
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 py-4">
        <div className="relative w-full max-w-sm min-w-56">
          <HugeiconsIcon
            icon={Search01Icon}
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={filter.query}
            onChange={(event) => onFilter({ ...filter, query: event.target.value })}
            placeholder="Search company, role, stack"
            aria-label="Search company, role, stack"
            className="pl-8"
          />
        </div>

        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>
            <HugeiconsIcon icon={FilterIcon} />
            Filter
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-0">
            <Command>
              <CommandList>
                <CommandGroup heading="Route">
                  {BUCKETS.map((value) => (
                    <CommandItem
                      key={value}
                      value={`route ${value}`}
                      data-checked={filter.buckets.includes(value)}
                      onSelect={() => setBuckets(value)}
                    >
                      {value}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Channel">
                  {CHANNELS.map((value) => (
                    <CommandItem
                      key={value}
                      value={`channel ${value}`}
                      data-checked={filter.channels.includes(value)}
                      onSelect={() => setChannels(value)}
                    >
                      {value}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Posting">
                  {POSTINGS.map((value) => (
                    <CommandItem
                      key={value}
                      value={`posting ${POSTING_LABELS[value]}`}
                      data-checked={filter.postings.includes(value)}
                      onSelect={() => setPostings(value)}
                    >
                      {POSTING_LABELS[value]}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Status">
                  {LIFECYCLES.map((value) => (
                    <CommandItem
                      key={value}
                      value={`status ${value}`}
                      data-checked={filter.statuses.includes(value)}
                      onSelect={() => setStatuses(value)}
                    >
                      {value}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                {/* Click cycles: narrow to this source, then banish it, then
                    clear. The count is store-wide, so it does not move as you
                    filter with it. */}
                <CommandGroup heading="Source">
                  {sources.map((row) => {
                    const state = sourceState(filter, row.source)
                    return (
                      <CommandItem
                        key={row.source}
                        value={`source ${row.source}`}
                        data-checked={state === "only"}
                        onSelect={() => setSource(row.source)}
                      >
                        {state === "not" ?
                          <HugeiconsIcon icon={UnavailableIcon} className="text-destructive" />
                        : null}
                        <span className={state === "not" ? "text-muted-foreground line-through" : undefined}>
                          {row.source}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                          {row.count.toLocaleString()}
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Score">
                  {SCORE_BANDS.map((value) => (
                    <CommandItem
                      key={value}
                      value={`score ${SCORE_BAND_LABELS[value]}`}
                      data-checked={filter.bands.includes(value)}
                      onSelect={() => setBands(value)}
                    >
                      {SCORE_BAND_LABELS[value]}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>
            <HugeiconsIcon icon={Calendar01Icon} />
            Found
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              mode="range"
              autoFocus
              // Scouting the future is not a thing, so the half of the grid that
              // could only ever match nothing is not offered.
              disabled={{ after: new Date() }}
              // Spread rather than a `undefined` literal: `defaultMonth?: Date`
              // does not admit one under `exactOptionalPropertyTypes`.
              {...(filter.found.to === null ? {} : { defaultMonth: dateOf(filter.found.to) })}
              selected={foundRange}
              onSelect={(next: DateRange | undefined) =>
                setFound({
                  from: next?.from === undefined ? null : isoOf(next.from),
                  to: next?.to === undefined ? null : isoOf(next.to),
                })
              }
            />
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className="ml-auto" />}>
            Columns
            <HugeiconsIcon icon={ArrowDown01Icon} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {/* Base UI requires a label to sit inside a group. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {COLUMNS.map((id) => (
                <DropdownMenuCheckboxItem
                  key={id}
                  checked={columns.includes(id)}
                  onCheckedChange={() => toggleColumn(id)}
                >
                  {columnLabel(id)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToggleGroup
          variant="outline"
          spacing={0}
          value={[view]}
          onValueChange={(next) => {
            const first = next[0]
            // An empty array means the user unpressed the active view; a list
            // always needs one, so keep the current one.
            if (first !== undefined && isView(first)) onView(first)
          }}
          aria-label="View"
        >
          {VIEWS.map((id) => (
            <ToggleGroupItem key={id} value={id} aria-label={VIEW_LABELS[id]} title={VIEW_LABELS[id]}>
              {id === "table" ?
                <HugeiconsIcon icon={RowsThreeIcon} />
              : <HugeiconsIcon icon={GridViewIcon} />}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <Tabs
          value={filter.segment}
          onValueChange={(next: unknown) => {
            if (isSegment(next)) onFilter({ ...filter, segment: next })
          }}
        >
          <TabsList>
            {SEGMENTS.map((segment) => (
              <TabsTrigger key={segment} value={segment}>
                {SEGMENT_LABELS[segment]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip.key} variant="outline" className="pr-1">
              {chip.label}
              <button
                type="button"
                onClick={chip.remove}
                aria-label={`Remove ${chip.label}`}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
              </button>
            </Badge>
          ))}
          <Button variant="link" size="xs" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      )}
    </div>
  )
}
