export { readFilter, writeFilter }

import { EMPTY_DAYS, EMPTY_FILTER, POSTINGS, SCORE_BANDS, SEGMENTS, dateOf, isoOf } from "@module/scout/helpers/select"
import { type DayRange, type Filter } from "@module/scout/helpers/select"
import { BUCKETS, CHANNELS, LIFECYCLES } from "@module/scout/types"

// One key, named only here — the same way fsa.ts keeps its IndexedDB ids
// private to the helper that uses them.
const KEY = "job-kit:scout-filter"

// Storage is untrusted input: an older shape, a hand-edited string, a half
// written value. Every field is narrowed back to its own vocabulary and a bad
// one falls to its empty value, so a corrupt entry costs the filter, not the page.
const isString = (raw: unknown): raw is string => typeof raw === "string"

const stringsOf = (raw: unknown): readonly string[] => (Array.isArray(raw) ? raw.filter(isString) : [])

const membersOf = <T extends string>(raw: unknown, vocabulary: readonly T[]): readonly T[] =>
  stringsOf(raw).filter((one): one is T => (vocabulary as readonly string[]).includes(one))

const oneOf = <T extends string>(raw: unknown, vocabulary: readonly T[], fallback: T): T =>
  isString(raw) && (vocabulary as readonly string[]).includes(raw) ? (raw as T) : fallback

// select.ts compares these lexically against `first_seen`, so a string that is
// not a day would quietly empty the table instead of being ignored. Shape alone
// is not enough: `2026-99-99` matches the pattern, and `dateOf` rolls it over to
// a real date, so round-trip through select.ts's own pair and keep the value
// only when it survives unchanged.
const DAY = /^\d{4}-\d{2}-\d{2}$/

const dayOf = (raw: unknown): string | null =>
  isString(raw) && DAY.test(raw) && isoOf(dateOf(raw)) === raw ? raw : null

// A `from` after its `to` is a window no dossier can fall in. It reads as a
// filter rather than a broken one, so it empties the table just as quietly.
const daysOf = (raw: unknown): DayRange => {
  if (raw === null || typeof raw !== "object") return EMPTY_DAYS
  const range = raw as { readonly from?: unknown; readonly to?: unknown }
  const from = dayOf(range.from)
  const to = dayOf(range.to)
  if (from !== null && to !== null && from > to) return EMPTY_DAYS
  return { from, to }
}

const filterOf = (raw: unknown): Filter => {
  if (raw === null || typeof raw !== "object") return EMPTY_FILTER
  const stored = raw as Record<string, unknown>
  return {
    query: isString(stored.query) ? stored.query : "",
    segment: oneOf(stored.segment, SEGMENTS, "all"),
    bands: membersOf(stored.bands, SCORE_BANDS),
    buckets: membersOf(stored.buckets, BUCKETS),
    channels: membersOf(stored.channels, CHANNELS),
    postings: membersOf(stored.postings, POSTINGS),
    statuses: membersOf(stored.statuses, LIFECYCLES),
    // Operator-minted pack ids, not a closed vocabulary (select.ts:106) — any
    // string is a real source. `sources` and `excluded` are not forced disjoint
    // either: matches() ranks exclusion first so overlap is already legal.
    sources: stringsOf(stored.sources),
    excluded: stringsOf(stored.excluded),
    found: daysOf(stored.found),
  }
}

// A disabled or full localStorage is a normal browser, not a broken one — the
// visit runs on EMPTY_FILTER and the write is dropped, the same degradation
// use-access takes when persistHandle fails.
const readFilter = (): Filter => {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === null ? EMPTY_FILTER : filterOf(JSON.parse(stored))
  } catch {
    return EMPTY_FILTER
  }
}

const writeFilter = (filter: Filter): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify(filter))
  } catch {
    // Persisting is a convenience; the filter still applies this visit.
  }
}
