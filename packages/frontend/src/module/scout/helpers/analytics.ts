export {
  RANGES,
  anchorOf,
  appliedDates,
  deltaPct,
  foundDates,
  isHighScore,
  isLive,
  pairedSeries,
  seriesOf,
  sourceSeries,
  tallyAppliedBySource,
  tallyBy,
  windowOf,
  type PairedPoint,
  type RangeKey,
  type SeriesPoint,
  type TallyRow,
  type Window,
}

import { type Dossier } from "@module/scout/types"

const DAY_MS = 86_400_000

const RANGES = [
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
] as const

type RangeKey = (typeof RANGES)[number]["key"]
type SeriesPoint = { readonly date: string; readonly count: number }
type PairedPoint = SeriesPoint & {
  readonly prior?: number
  readonly priorDate?: string
}
type TallyRow = { readonly label: string; readonly count: number }
type Window = { readonly from: string; readonly to: string }
// The days a dossier contributes a count on. Discovery has exactly one; an
// application has one per attempt, on the day it was sent.
type Stamps = (d: Dossier) => readonly string[]
// One row per day, carrying a count per source. The keys are the source ids
// themselves, so the index signature has to admit `date` alongside them.
type SourcePoint = { readonly date: string; readonly [source: string]: number | string }

const isHighScore = (d: Dossier) => d.score.kind === "scored" && d.score.value >= 8
const isLive = (d: Dossier) => d.posting.kind === "live"

function toUtc(iso: string): number {
  const [year, month, day] = iso.split("-")
  return Date.UTC(Number(year), Number(month) - 1, Number(day))
}

const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// The window is anchored to the newest activity rather than to today: the store
// is a snapshot on disk, so a corpus generated last month would render every
// "last 30 days" panel empty if we counted back from the wall clock. Log dates
// count because an application is usually written after `firstSeen`.
function anchorOf(all: readonly Dossier[]): string {
  let newest = ""
  for (const d of all) {
    if (d.firstSeen > newest) newest = d.firstSeen
    for (const entry of d.log) if (entry.date > newest) newest = entry.date
  }
  return newest === "" ? toIso(Date.now()) : newest
}

function windowOf(anchor: string, days: number | null, back = 0): Window {
  const to = toUtc(anchor)
  if (days === null) return { from: "0000-01-01", to: anchor }

  const span = days * DAY_MS
  const end = to - back * span
  return { from: toIso(end - span + DAY_MS), to: toIso(end) }
}

const within = (d: Dossier, w: Window) => d.firstSeen >= w.from && d.firstSeen <= w.to

const foundDates: Stamps = (d) => [d.firstSeen]

// `applied via {channel}` is the line job-apply appends — see
// skill/job-apply/references/flows/flow-record.md. An application is stamped on
// the day it was sent, never on `firstSeen`: a dossier found in March and
// applied to yesterday belongs to yesterday.
const APPLIED = "applied via"
const appliedDates: Stamps = (d) => d.log.filter((e) => e.event.startsWith(APPLIED)).map((e) => e.date)

// Zero-filled so a quiet week reads as a flat line rather than a missing gap.
function daily(all: readonly Dossier[], w: Window, stamps: Stamps): readonly SeriesPoint[] {
  const counts = new Map<string, number>()
  for (const d of all) {
    for (const date of stamps(d)) {
      if (date < w.from || date > w.to) continue
      counts.set(date, (counts.get(date) ?? 0) + 1)
    }
  }

  // All-time still has to emit stamps older than min firstSeen (backfilled
  // applications on a stub whose first_seen is today).
  let start = w.from === "0000-01-01" ? earliest(all, w) : w.from
  if (w.from === "0000-01-01") {
    for (const date of counts.keys()) if (date < start) start = date
  }
  const points: SeriesPoint[] = []
  for (let ms = toUtc(start); ms <= toUtc(w.to); ms += DAY_MS) {
    const date = toIso(ms)
    points.push({ date, count: counts.get(date) ?? 0 })
  }
  return points
}

// The tiles ask "which dossiers match", not "which days", so the predicate
// form stays — it is the same question `deltaPct` asks.
const seriesOf = (all: readonly Dossier[], w: Window, pick: (d: Dossier) => boolean) =>
  daily(all, w, (d) => (pick(d) ? foundDates(d) : []))

function earliest(all: readonly Dossier[], w: Window): string {
  let oldest = ""
  for (const d of all) {
    if (oldest === "" || d.firstSeen < oldest) oldest = d.firstSeen
  }
  return oldest === "" ? w.to : oldest
}

// The two windows cover different calendar days, so the comparison line is
// aligned by position in the window — day 1 against day 1 — and carries its own
// date for the tooltip.
function pairedSeries(
  all: readonly Dossier[],
  current: Window,
  previous: Window | null,
  stamps: Stamps
): readonly PairedPoint[] {
  const now = daily(all, current, stamps)
  const before = previous === null ? [] : daily(all, previous, stamps)
  const offset = before.length - now.length

  return now.map((point, index) => {
    const prior = before[index + offset]
    return {
      date: point.date,
      count: point.count,
      ...(prior === undefined ? {} : { prior: prior.count, priorDate: prior.date }),
    }
  })
}

function countIn(all: readonly Dossier[], w: Window, pick: (d: Dossier) => boolean): number {
  let n = 0
  for (const d of all) if (within(d, w) && pick(d)) n += 1
  return n
}

// null, not 0: "no change" and "no baseline to compare against" are different
// claims, and the card renders them differently.
function deltaPct(
  all: readonly Dossier[],
  current: Window,
  previous: Window,
  pick: (d: Dossier) => boolean
): number | null {
  const before = countIn(all, previous, pick)
  if (before === 0) return null
  return Math.round(((countIn(all, current, pick) - before) / before) * 100)
}

// Keeps the vocabulary's own order, and keeps empty buckets, so the pipeline
// reads as a fixed set of stages rather than a list that reshuffles per filter.
function tallyBy<T extends string>(
  all: readonly Dossier[],
  w: Window,
  vocab: readonly T[],
  key: (d: Dossier) => T
): readonly TallyRow[] {
  const counts = new Map<T, number>(vocab.map((v) => [v, 0]))
  for (const d of all) {
    if (!within(d, w)) continue
    counts.set(key(d), (counts.get(key(d)) ?? 0) + 1)
  }
  return vocab.map((label) => ({ label, count: counts.get(label) ?? 0 }))
}

const OTHER = "other"

// Sources are search-pack ids the operator can mint, so the vocabulary comes
// from the data rather than a fixed list like `tallyBy` takes. A long tail of
// one-offs would be a dozen unreadable lines, so everything past the leaders
// folds into one bucket and the rows still add up to the range total.
function sourceSeries(
  all: readonly Dossier[],
  w: Window,
  limit: number
): { readonly rows: readonly TallyRow[]; readonly points: readonly SourcePoint[] } {
  const totals = new Map<string, number>()
  for (const d of all) {
    if (!within(d, w)) continue
    totals.set(d.provenance.source, (totals.get(d.provenance.source) ?? 0) + 1)
  }

  const ranked = [...totals]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const leaders = new Set(ranked.slice(0, limit).map((r) => r.label))
  const tail = ranked.filter((r) => !leaders.has(r.label)).reduce((n, r) => n + r.count, 0)
  const rows = tail === 0 ? ranked : [...ranked.slice(0, limit), { label: OTHER, count: tail }]

  const counts = new Map<string, Map<string, number>>()
  for (const d of all) {
    if (!within(d, w)) continue
    const label = leaders.has(d.provenance.source) ? d.provenance.source : OTHER
    const day = counts.get(d.firstSeen) ?? new Map<string, number>()
    day.set(label, (day.get(label) ?? 0) + 1)
    counts.set(d.firstSeen, day)
  }

  const start = w.from === "0000-01-01" ? earliest(all, w) : w.from
  const points: SourcePoint[] = []
  for (let ms = toUtc(start); ms <= toUtc(w.to); ms += DAY_MS) {
    const date = toIso(ms)
    const day = counts.get(date)
    points.push({ date, ...Object.fromEntries(rows.map((r) => [r.label, day?.get(r.label) ?? 0])) })
  }
  return { rows, points }
}

// Applications are stamped on send day (`applied via`), not firstSeen: a
// dossier found in March and applied to yesterday belongs to yesterday.
// Vocabulary is every pack id in `all`, so a source with no in-window
// attempt still appears as zero — same keep-empty rule as `tallyBy`.
function tallyAppliedBySource(all: readonly Dossier[], w: Window): readonly TallyRow[] {
  const counts = new Map<string, number>()
  for (const d of all) {
    if (!counts.has(d.provenance.source)) counts.set(d.provenance.source, 0)
    for (const date of appliedDates(d)) {
      if (date < w.from || date > w.to) continue
      counts.set(d.provenance.source, (counts.get(d.provenance.source) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
