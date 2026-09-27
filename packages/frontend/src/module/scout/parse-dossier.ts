export { parseDossier }

import { err, ok } from "@module/scout/result"
import {
  DIRECT_APPLY,
  UNKNOWN_TEXT,
  isBucket,
  isChannel,
  isFactKey,
  isLifecycle,
  isWriter,
  toIsoDate,
} from "@module/scout/types"
import {
  type Dossier,
  type Excerpt,
  type FactKey,
  type FactValue,
  type Factor,
  type LogEntry,
  type ParseError,
  type ParsedDossier,
  type Posting,
  type Provenance,
  type Role,
  type Score,
  type Verdict,
} from "@module/scout/types"

// The grammar below was recovered by round-tripping the corpus on disk, so the
// odd-looking rules are the corpus, not taste: titles carry ": " and " — ",
// five fact values carry a raw pipe, the verdict header changes shape and
// order between files, some Verdict lines omit `live · why` (pack stub in
// slot 3), Provenance is labeled (`source · channel · author · date`) or
// unlabeled with authors that contain ` · `, and the log is the tail after
// the ownership marker (or `## Application log` when the marker is absent) —
// the heading itself is not required.

const FRONTMATTER_KEYS = [
  "company",
  "title",
  "url",
  "status",
  "first_seen",
  "last_seen",
  "score",
  "bucket",
  "channel",
] as const

// Only these two are required by heading. `## The role` post-dates most of the
// corpus and `## From the posting` pre-dates the rest, so both are read when
// present. `## Provenance` stays mandatory in effect — parseProvenance fails on
// a missing line.
const REQUIRED_SECTIONS = ["## Verdict", "## Posting facts"] as const

const OWNERSHIP_MARKER = "<!-- scout never writes below this line -->"
// Named, not positional: slotting `query` between `contact` and `date` would
// shift every index after it.
const LABELED_PROVENANCE =
  /^source (?<source>.+?) · channel (?<channel>.+?) · author (?<author>.+?)(?: · contact (?<contact>.+?))?(?: · query (?<query>.+?))? · date (?<date>.+)$/

const VERDICT_LINE = /^score \*\*(.+?)\*\* · (.+?) · (.+?)(?: · (.*))?$/
const LOG_LINE = /^- (\d{4}-\d{2}-\d{2}) · (.*) — ([a-z-]+)$/
const APPLICATION_LINE = /^#### Application /gm
const FACTS_HEADER = "key | value"
const NUMERIC = /^-?\d+(?:\.\d+)?$/

function parseDossier(file: string, raw: string): ParsedDossier {
  const fail = (at: string, cause: ParseError["cause"]): ParsedDossier => err({ file, at, cause })
  const lines = raw.split("\n")

  /* -- frontmatter -------------------------------------------------------- */

  if (lines[0] !== "---") {
    return fail("frontmatter", {
      kind: "frontmatter",
      detail: "no --- on line 1",
    })
  }
  const close = lines.indexOf("---", 1)
  if (close === -1) {
    return fail("frontmatter", {
      kind: "frontmatter",
      detail: "unterminated frontmatter",
    })
  }

  const fields = new Map<string, string>()
  for (const line of lines.slice(1, close)) {
    if (line.trim() === "") continue
    // First ": " only — seven titles hold a second one.
    const at = line.indexOf(": ")
    if (at === -1) {
      return fail("frontmatter", { kind: "frontmatter", detail: line })
    }
    fields.set(line.slice(0, at), unquote(line.slice(at + 2)))
  }
  const missing = FRONTMATTER_KEYS.filter((key) => !fields.has(key))
  if (missing.length > 0) {
    return fail("frontmatter", {
      kind: "frontmatter",
      detail: `missing ${missing.join(", ")}`,
    })
  }
  const read = (key: string): string => fields.get(key) ?? ""

  const status = read("status")
  if (!isLifecycle(status)) {
    return fail("frontmatter", {
      kind: "vocabulary",
      field: "status",
      got: status,
    })
  }
  const rawBucket = read("bucket")
  const bucket = rawBucket === "EU/US-only" ? "restricted-geo" : rawBucket
  if (!isBucket(bucket)) {
    return fail("frontmatter", {
      kind: "vocabulary",
      field: "bucket",
      got: rawBucket,
    })
  }
  const channel = read("channel")
  if (!isChannel(channel)) {
    return fail("frontmatter", {
      kind: "vocabulary",
      field: "channel",
      got: channel,
    })
  }
  const firstSeen = toIsoDate(read("first_seen"))
  if (firstSeen === null) {
    return fail("frontmatter", {
      kind: "date",
      field: "first_seen",
      got: read("first_seen"),
    })
  }
  const lastSeen = toIsoDate(read("last_seen"))
  if (lastSeen === null) {
    return fail("frontmatter", {
      kind: "date",
      field: "last_seen",
      got: read("last_seen"),
    })
  }
  const url = read("url")
  const host = hostOf(url)
  if (host === null) {
    return fail("frontmatter", {
      kind: "frontmatter",
      detail: `unparseable url ${url}`,
    })
  }

  /* -- sections ----------------------------------------------------------- */

  // The "# company — title" heading is never read: two titles contain " — ".
  const body = lines.slice(close + 1)
  // job-application stubs have frontmatter + a log tail and no scout body.
  // Read the log first so a stub still parses; require the other headings only
  // when ## Verdict is present.
  const logged = readLog(logTail(body), fail)
  if (logged.kind === "fail") return logged.result
  const { log, posting, applications } = logged

  if (body.indexOf("## Verdict") === -1) {
    const rawScore = read("score")
    const score: Score = NUMERIC.test(rawScore) ? { kind: "scored", value: Number(rawScore) } : { kind: "unscored" }
    return ok({
      file,
      company: read("company"),
      title: read("title"),
      url,
      host,
      status,
      firstSeen,
      lastSeen,
      score,
      bucket,
      channel,
      verdict: { factors: [] },
      facts: factsFrom(new Map()),
      role: EMPTY_ROLE,
      excerpt: { kind: "absent" },
      provenance: {
        source: DIRECT_APPLY,
        author: { kind: "unknown" },
        contact: { kind: "unknown" },
        matchedQuery: { kind: "unknown" },
        date: UNKNOWN_TEXT,
      },
      log,
      posting,
      applications,
    })
  }

  const sections = sectionMap(body)
  for (const heading of REQUIRED_SECTIONS) {
    if (!sections.has(heading)) return fail(heading, { kind: "section", heading })
  }
  const sectionAt = (heading: string): readonly string[] => sections.get(heading) ?? []

  /* -- verdict ------------------------------------------------------------ */

  const verdictBody = sectionAt("## Verdict")
  const headline = verdictBody.map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("|"))
  // Group 4 is the legacy `why` tail. Still matched so old files parse; never read.
  const match = headline === undefined ? null : VERDICT_LINE.exec(headline)
  if (match === null) {
    return fail("## Verdict line", { kind: "section", heading: "## Verdict" })
  }

  const pipes = verdictBody.filter((line) => line.trim().startsWith("|"))
  const headerLine = pipes[0]
  const rowLine = pipes[2]
  // Three lines exactly: header, decorative separator, row.
  if (pipes.length !== 3 || headerLine === undefined || rowLine === undefined) {
    return fail("## Verdict table", {
      kind: "table",
      detail: `expected 3 pipe lines, got ${pipes.length}`,
    })
  }
  const header = cells(headerLine)
  const row = cells(rowLine)
  if (header.length !== row.length || header.length < 2) {
    return fail("## Verdict table", {
      kind: "table",
      detail: `header ${header.length} cells, row ${row.length}`,
    })
  }
  if (header[header.length - 1] !== "=") {
    return fail("## Verdict table", {
      kind: "table",
      detail: "header does not end in =",
    })
  }
  // Positional: the header carries three different label sets and orders.
  const factors: Factor[] = header.slice(0, -1).map((label, index) => ({
    label,
    points: value(row[index] ?? UNKNOWN_TEXT),
  }))
  const verdict: Verdict = { factors }

  const total = row[row.length - 1] ?? UNKNOWN_TEXT
  const score: Score = NUMERIC.test(total) ? { kind: "scored", value: Number(total) } : { kind: "unscored" }
  if (score.kind === "scored" && Number(read("score")) !== score.value) {
    return fail("## Verdict table", {
      kind: "score-mismatch",
      frontmatter: read("score"),
      table: total,
    })
  }

  /* -- posting facts ------------------------------------------------------ */

  const factLines = sectionAt("## Posting facts").filter((line) => line.trim().startsWith("|"))
  const factHeader = factLines[0]
  // Column padding varies between files, so the header is matched on cells.
  if (factHeader === undefined || cells(factHeader).join(" | ") !== FACTS_HEADER) {
    return fail("## Posting facts", {
      kind: "table",
      detail: `no | ${FACTS_HEADER} | header`,
    })
  }
  const factRows = factLines.slice(2).map(splitFactRow)
  const oneCell = factRows.indexOf(null)
  if (oneCell !== -1) {
    return fail(`## Posting facts row ${oneCell + 1}`, { kind: "table", detail: "row has one cell" })
  }
  // Keyed, not positional: a row this build has retired (`status_reason`, on
  // every pre-redesign file) is dropped here, not treated as a defect. A Map
  // rather than a Partial<Record> — exactOptionalPropertyTypes makes the record
  // form fight Object.fromEntries, and `get` returns the optionality for free.
  const facts = factsFrom(
    new Map(factRows.flatMap((row) => (row !== null && isFactKey(row.key) ? [[row.key, row.value] as const] : [])))
  )

  /* -- role ---------------------------------------------------------------- */

  const role = parseRole(sectionAt("## The role"))

  /* -- excerpt ------------------------------------------------------------ */

  const quoted = sectionAt("## From the posting").filter((line) => line.startsWith(">"))
  // No text key at all when absent — the body reads "_(not printed)_".
  const excerpt: Excerpt =
    quoted.length === 0 ?
      { kind: "absent" }
    : {
        kind: "printed",
        text: quoted
          .map((line) => line.replace(/^>\s?/, ""))
          .join("\n")
          .trim(),
      }

  /* -- provenance --------------------------------------------------------- */

  const provLine = sectionAt("## Provenance").find((line) => line.trim() !== "")
  const provenance = parseProvenance(provLine)
  if (provenance === null) {
    return fail("## Provenance", {
      kind: "section",
      heading: "## Provenance",
    })
  }

  /* -- log already read above --------------------------------------------- */

  const dossier: Dossier = {
    file,
    company: read("company"),
    title: read("title"),
    url,
    host,
    status,
    firstSeen,
    lastSeen,
    score,
    bucket,
    channel,
    verdict,
    facts,
    role,
    excerpt,
    provenance,
    log,
    posting,
    applications,
  }
  return ok(dossier)
}

/* -- helpers -------------------------------------------------------------- */

type LogRead =
  | { readonly kind: "ok"; readonly log: readonly LogEntry[]; readonly posting: Posting; readonly applications: number }
  | { readonly kind: "fail"; readonly result: ParsedDossier }

// Scan to EOF. The "scout never writes below this line" comment is not a
// delimiter (43 files print it twice) and blank lines are not terminators.
function readLog(tail: readonly string[], fail: (at: string, cause: ParseError["cause"]) => ParsedDossier): LogRead {
  const log: LogEntry[] = []
  for (const line of tail) {
    const match = LOG_LINE.exec(line)
    if (match === null) continue
    const [, stamp, event, writer] = match
    if (stamp === undefined || event === undefined || writer === undefined) {
      continue
    }
    const date = toIsoDate(stamp)
    if (date === null) {
      return {
        kind: "fail",
        result: fail("log", { kind: "date", field: "log", got: stamp }),
      }
    }
    if (!isWriter(writer)) {
      return {
        kind: "fail",
        result: fail("log", { kind: "vocabulary", field: "writer", got: writer }),
      }
    }
    log.push({ date, event, writer })
  }

  // Last transition wins.
  const posting = log.reduce<Posting>(
    (current, entry) =>
      entry.event.startsWith("posting dead") ? { kind: "dead", since: entry.date }
      : entry.event === "posting live again" ? { kind: "live" }
      : current,
    { kind: "live" }
  )

  // Counted across the whole tail: one file interleaves a record between two
  // log lines, so records are not reliably last.
  const applications = (tail.join("\n").match(APPLICATION_LINE) ?? []).length
  return { kind: "ok", log, posting, applications }
}

function logTail(body: readonly string[]): readonly string[] {
  const marker = body.indexOf(OWNERSHIP_MARKER)
  if (marker !== -1) return body.slice(marker + 1)
  const heading = body.indexOf("## Application log")
  if (heading !== -1) return body.slice(heading + 1)
  return []
}

function parseProvenance(provLine: string | undefined): Provenance | null {
  if (provLine === undefined) return null
  const line = provLine.trim()
  const labeled = LABELED_PROVENANCE.exec(line)
  if (labeled !== null) {
    const { source, author, contact, query, date } = labeled.groups ?? {}
    if (source === undefined || author === undefined || date === undefined) return null
    return {
      source: source.trim(),
      author: value(author.trim()),
      contact: value((contact ?? UNKNOWN_TEXT).trim()),
      matchedQuery: value((query ?? UNKNOWN_TEXT).trim()),
      date: date.trim(),
    }
  }
  // Legacy unlabeled: source · author · contact · date (author may contain " · ").
  const parts = line.split(" · ")
  // A modern line with no ` · date ` tail lands here too (the labeled regex
  // requires it), and its first segment still carries the label word.
  const source = parts[0]?.replace(/^source /, "")
  const seen = parts.at(-1)
  const contact = parts.at(-2)
  const author = parts.slice(1, -2).join(" · ")
  if (parts.length < 4 || source === undefined || contact === undefined || seen === undefined) {
    return null
  }
  return {
    source: source.trim(),
    author: value(author.trim()),
    contact: value(contact.trim()),
    matchedQuery: { kind: "unknown" },
    date: seen.trim(),
  }
}

const UNKNOWN: FactValue = { kind: "unknown" }

// A key the table did not print is unknown, not a parse failure: the corpus
// spans two vocabularies, and the sheet renders nothing for an unknown anyway.
// Written out rather than folded over FACT_KEYS so the record is total by
// construction — no assertion, and the compiler owns completeness.
const factsFrom = (found: ReadonlyMap<FactKey, FactValue>): Readonly<Record<FactKey, FactValue>> => ({
  status: found.get("status") ?? UNKNOWN,
  seniority: found.get("seniority") ?? UNKNOWN,
  work_model: found.get("work_model") ?? UNKNOWN,
  location: found.get("location") ?? UNKNOWN,
  salary: found.get("salary") ?? UNKNOWN,
  equity: found.get("equity") ?? UNKNOWN,
  years_experience: found.get("years_experience") ?? UNKNOWN,
  work_auth: found.get("work_auth") ?? UNKNOWN,
  hiring_route: found.get("hiring_route") ?? UNKNOWN,
  eligibility: found.get("eligibility") ?? UNKNOWN,
  eligibility_evidence: found.get("eligibility_evidence") ?? UNKNOWN,
  required_skills: found.get("required_skills") ?? UNKNOWN,
  jd_date: found.get("jd_date") ?? UNKNOWN,
  apply_url: found.get("apply_url") ?? UNKNOWN,
  ats: found.get("ats") ?? UNKNOWN,
  match_score: found.get("match_score") ?? UNKNOWN,
  match_decision: found.get("match_decision") ?? UNKNOWN,
  match_confidence: found.get("match_confidence") ?? UNKNOWN,
  blocker: found.get("blocker") ?? UNKNOWN,
})

// Headings located once and sliced to the next, so a section the file does not
// carry is absence rather than a parse failure.
const sectionMap = (lines: readonly string[]): ReadonlyMap<string, readonly string[]> => {
  const heads = lines.flatMap((line, at) => (line.startsWith("## ") ? [{ heading: line.trim(), at }] : []))
  return new Map(
    heads.map((head, index) => [head.heading, lines.slice(head.at + 1, heads[index + 1]?.at ?? lines.length)])
  )
}

// First remaining pipe only: five values print a raw pipe of their own. `null`
// is a row with no second cell, which the caller turns into one parse failure.
const splitFactRow = (line: string): { readonly key: string; readonly value: FactValue } | null => {
  const inner = unpipe(line)
  const split = inner.indexOf("|")
  return split === -1 ? null : { key: inner.slice(0, split).trim(), value: value(inner.slice(split + 1).trim()) }
}

const SNAPSHOT = "**Snapshot** — "
const EMPTY_ROLE: Role = { snapshot: "", responsibilities: [], requirements: [] }

// A line either opens a subhead or belongs to the one already open, so the
// section folds: the accumulator carries which list is receiving.
type RoleFold = { readonly role: Role; readonly open: "none" | "do" | "must" }

const foldRoleLine = (acc: RoleFold, raw: string): RoleFold => {
  const line = raw.trim()
  const { role } = acc
  if (line.startsWith(SNAPSHOT)) return { role: { ...role, snapshot: line.slice(SNAPSHOT.length) }, open: "none" }
  if (line === "**What you'd do**") return { ...acc, open: "do" }
  if (line === "**Must have**") return { ...acc, open: "must" }
  if (!line.startsWith("- ")) return acc
  const item = line.slice(2).trim()
  if (acc.open === "do") return { ...acc, role: { ...role, responsibilities: [...role.responsibilities, item] } }
  if (acc.open === "must") return { ...acc, role: { ...role, requirements: [...role.requirements, item] } }
  return acc
}

// Two fixed subheads, both optional. Anything else in the section is ignored
// rather than guessed at.
const parseRole = (lines: readonly string[]): Role =>
  lines.reduce(foldRoleLine, { role: EMPTY_ROLE, open: "none" }).role

// One leading and one trailing quote; the writer has no escape mechanism.
function unquote(raw: string): string {
  const head = raw.startsWith('"') ? raw.slice(1) : raw
  return head.endsWith('"') ? head.slice(0, -1) : head
}

function unpipe(line: string): string {
  const trimmed = line.trim()
  const head = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed
  return head.endsWith("|") ? head.slice(0, -1) : head
}

const cells = (line: string): string[] =>
  unpipe(line)
    .split("|")
    .map((cell) => cell.trim())

const value = (text: string): FactValue => (text === UNKNOWN_TEXT ? { kind: "unknown" } : { kind: "known", text })

function hostOf(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname
  } catch {
    return null
  }
}
