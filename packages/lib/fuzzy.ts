export { match, search, type Match, type SearchOptions }

import { type Maybe, Just, Nothing, mapMaybe } from "@lib/maybe"

/**
 * Subsequence fuzzy matching with boundary/consecutive bonuses and gap
 * penalties, ported from commit-tools' model selector. `search` filters and
 * ranks a list of items; `match` scores one string against one query. See each
 * export's JSDoc for runnable examples.
 *
 * Per matched character the score adds: +16 base, +8 when the character starts
 * a word (first char, or right after a separator), +4 when it sits right after
 * the previous matched character. Characters the query skips over cost -3 for
 * the first skipped char and -1 for each further one. Higher total wins.
 */

/**
 * A successful fuzzy match.
 *
 * @property score how good the match is; higher ranks first.
 * @property positions indices in the matched target string that the query hit,
 *   in order. Useful for highlighting (unused by the org search).
 */
type Match = {
  score: number
  positions: ReadonlyArray<number>
}

/**
 * @property caseSensitive force case-sensitive matching. Defaults to smart-case:
 *   sensitive only when the query contains an uppercase letter.
 * @property separators token delimiters applied to the query. Defaults to
 *   whitespace and `- _ . /`.
 */
type SearchOptions = {
  caseSensitive?: boolean
  separators?: RegExp
}

const SEPARATORS = /[\s\-_./]+/
const SEPARATOR_CHAR = /[\s\-_./]/

const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CONSECUTIVE = 4
const PENALTY_GAP_START = -3
const PENALTY_GAP_EXTEND = -1

const applyCase = (s: string, caseSensitive: boolean): string => (caseSensitive ? s : s.toLowerCase())

const isBoundary = (target: string, i: number): boolean => {
  if (i === 0) return true
  const prev = target[i - 1]
  return prev !== undefined && SEPARATOR_CHAR.test(prev)
}

type TokenScore = { score: number; end: number; positions: ReadonlyArray<number> }
type GapScan = { matchIndex: number; gapPenalty: number }

const scanForChar = (target: string, from: number, ch: string): Maybe<GapScan> => {
  let ti = from
  let gapPenalty = 0
  let inGap = false
  // `ch` is one code point, which may span two UTF-16 units, so compare as a substring.
  while (ti < target.length && !target.startsWith(ch, ti)) {
    gapPenalty += inGap ? PENALTY_GAP_EXTEND : PENALTY_GAP_START
    inGap = true
    ti++
  }
  return ti >= target.length ? Nothing() : Just({ matchIndex: ti, gapPenalty })
}

const scoreMatchAt = (target: string, ti: number, prevMatchIndex: number): number => {
  let score = SCORE_MATCH
  if (isBoundary(target, ti)) score += BONUS_BOUNDARY
  if (prevMatchIndex === ti - 1) score += BONUS_CONSECUTIVE
  return score
}

const scoreToken = (token: string, target: string, from: number): Maybe<TokenScore> => {
  const positions: number[] = []
  let score = 0
  let prevMatchIndex = -1
  let ti = from

  for (const ch of token) {
    const found = scanForChar(target, ti, ch)
    if (found.isNothing()) return Nothing()
    const inner = found.expect("checked above")
    score += inner.gapPenalty + scoreMatchAt(target, inner.matchIndex, prevMatchIndex)
    positions.push(inner.matchIndex)
    // Last UTF-16 unit of this match, so the next match counts as consecutive after an astral character.
    prevMatchIndex = inner.matchIndex + ch.length - 1
    ti = inner.matchIndex + ch.length
  }
  return Just({ score, end: ti, positions })
}

const scoreAllTokens = (tokens: ReadonlyArray<string>, target: string): Maybe<Match> => {
  let cursor = 0
  let total = 0
  const allPositions: number[] = []
  for (const tok of tokens) {
    const r = scoreToken(tok, target, cursor)
    if (r.isNothing()) return Nothing()
    const inner = r.expect("checked above")
    total += inner.score
    allPositions.push(...inner.positions)
    cursor = inner.end
  }
  return Just({ score: total, positions: allPositions })
}

/**
 * Score how well `query` fuzzy-matches a single `target` string.
 *
 * Splits `query` into tokens on whitespace and `- _ . /`, then walks `target`
 * left to right locating each token's characters in order. Characters need not
 * be adjacent; skipped characters cost points and matches at word boundaries
 * earn a bonus. Returns `Nothing` when a token's characters are not all present
 * in order. Matching ignores case unless `query` has an uppercase letter.
 *
 * @returns `Just<Match>` (score + matched positions), or `Nothing` if no match.
 *
 * @example
 * match("ac", "Acme").isJust();             // true  — 'a','c' found in order
 * match("acme", "Acme").expect("").score;   // high  — boundary + consecutive bonuses
 * match("cm", "Acme").expect("").score;     // lower — leading gap penalty before 'c'
 * match("xyz", "Acme").isNothing();         // true  — 'z' never appears
 * match("", "Acme").expect("").score;       // 0     — empty query matches anything
 */
const match = (query: string, target: string, options?: SearchOptions): Maybe<Match> => {
  const caseSensitive = options?.caseSensitive ?? /[A-Z]/.test(query)
  const sep = options?.separators ?? SEPARATORS
  const tokens = applyCase(query, caseSensitive).split(sep).filter(Boolean)
  if (tokens.length === 0) return Just({ score: 0, positions: [] })
  return scoreAllTokens(tokens, applyCase(target, caseSensitive))
}

/**
 * Filter and rank `items` by how well `query` fuzzy-matches any of their
 * `selectors`. Each selector projects an item to a searchable string; an item's
 * score is its best-scoring selector. Items matching no selector are dropped.
 *
 * An empty or whitespace-only `query` returns every item in original order
 * (score 0), so an unfiltered list renders unchanged.
 *
 * @param selectors strings to match against, e.g. `[o => o.name, o => o.slug]`.
 * @returns matching items sorted by descending score, each paired with its `Match`.
 *
 * @example
 * const orgs = [
 *   { name: "Acme West", slug: "acme-west" },
 *   { name: "Globex", slug: "globex" },
 * ];
 *
 * search("ac", orgs, [o => o.name, o => o.slug]).map(r => r.item.name);
 * // ["Acme West"]            — Globex matches no selector, so it is dropped
 *
 * search("glo bex", orgs, [o => o.name]).map(r => r.item.name);
 * // ["Globex"]               — multi-token: both "glo" and "bex" must match
 *
 * search("", orgs, [o => o.name]).map(r => r.item.name);
 * // ["Acme West", "Globex"]  — empty query keeps original order
 */
const search = <T>(
  query: string,
  items: ReadonlyArray<T>,
  selectors: ReadonlyArray<(item: T) => string>,
  options?: SearchOptions
): ReadonlyArray<{ item: T; match: Match }> => {
  if (query.trim().length === 0) {
    return items.map((item) => ({ item, match: { score: 0, positions: [] } }))
  }
  const scored = mapMaybe([...items], (item) => {
    const matches = mapMaybe([...selectors], (sel) => match(query, sel(item), options))
    if (matches.length === 0) return Nothing<{ item: T; match: Match }>()
    const best = matches.reduce((a, b) => (b.score > a.score ? b : a))
    return Just({ item, match: best })
  })
  return [...scored].sort((a, b) => b.match.score - a.match.score)
}
