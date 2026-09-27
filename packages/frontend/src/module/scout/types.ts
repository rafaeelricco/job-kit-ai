export {
  BUCKETS,
  CHANNELS,
  DIRECT_APPLY,
  FACT_KEYS,
  FACT_LABELS,
  LIFECYCLES,
  UNKNOWN_TEXT,
  WRITERS,
  factText,
  isBucket,
  isChannel,
  isFactKey,
  isLifecycle,
  isWriter,
  toIsoDate,
  type Bucket,
  type Channel,
  type Dossier,
  type Excerpt,
  type FactKey,
  type FactValue,
  type Factor,
  type IsoDate,
  type Lifecycle,
  type LogEntry,
  type ParseError,
  type ParsedDossier,
  type Posting,
  type Provenance,
  type Role,
  type Score,
  type Store,
  type TrashFailure,
  type TrashOpError,
  type Trashed,
  type Verdict,
  type Writer,
}

import type { Result } from "@module/scout/result"

/* -- closed vocabularies, each with a total guard ------------------------- */

const LIFECYCLES = ["new", "applied", "interview", "offer", "rejected", "dropped"] as const
const BUCKETS = ["direct", "EOR", "restricted-geo", "unbucketed"] as const
const CHANNELS = ["direct_email", "dm_request", "founder", "ats"] as const
// `job-application` is the pre-rename spelling of `job-apply`; dossiers written
// before the rename still carry it, so readers keep accepting it.
const WRITERS = ["job-scout", "job-prep", "job-apply", "job-inbox", "job-application", "operator"] as const
const FACT_KEYS = [
  "status",
  "seniority",
  "work_model",
  "location",
  "salary",
  "equity",
  "years_experience",
  "work_auth",
  "hiring_route",
  "eligibility",
  "eligibility_evidence",
  "required_skills",
  "jd_date",
  "apply_url",
  "ats",
  "match_score",
  "match_decision",
  "match_confidence",
  "blocker",
] as const

type Lifecycle = (typeof LIFECYCLES)[number]
type Bucket = (typeof BUCKETS)[number]
type Channel = (typeof CHANNELS)[number]
type Writer = (typeof WRITERS)[number]
type FactKey = (typeof FACT_KEYS)[number]

// One guard factory rather than four hand-written predicates.
const memberOf =
  <T extends string>(vocab: readonly T[]) =>
  (raw: string): raw is T =>
    (vocab as readonly string[]).includes(raw)

const isLifecycle = memberOf(LIFECYCLES)
const isBucket = memberOf(BUCKETS)
const isChannel = memberOf(CHANNELS)
const isWriter = memberOf(WRITERS)
// The corpus spans two vocabularies, so the parser reads fact rows by key and
// must recognize one this build no longer carries (`status_reason`).
const isFactKey = memberOf(FACT_KEYS)

// What the sheet renders. The markdown on disk keeps the snake_case keys, so
// this map is the whole of the rename — parser and skill contract are untouched
// by it. `status` is relabeled because the header also shows a lifecycle called
// status; `jd_date` takes the name every board prints.
const FACT_LABELS: Readonly<Record<FactKey, string>> = {
  status: "Posting state",
  seniority: "Seniority",
  work_model: "Work model",
  location: "Location",
  salary: "Salary",
  equity: "Equity",
  years_experience: "Years experience",
  work_auth: "Work authorization",
  hiring_route: "Hiring route",
  eligibility: "Eligibility",
  eligibility_evidence: "Eligibility evidence",
  required_skills: "Required skills",
  jd_date: "Posted",
  apply_url: "Apply URL",
  ats: "ATS",
  match_score: "Match score",
  match_decision: "Match decision",
  match_confidence: "Match confidence",
  blocker: "Blocker",
}

/* -- branded scalars ------------------------------------------------------ */

// A plain string date sorts wrong the moment a non-ISO value slips in, and the
// corpus compares these lexically. The brand forces every value through the
// smart constructor.
declare const IsoBrand: unique symbol
type IsoDate = string & { readonly [IsoBrand]: true }

const toIsoDate = (raw: string): IsoDate | null => (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? (raw as IsoDate) : null)

/* -- values --------------------------------------------------------------- */

// The corpus writes unknown as a literal em dash. Carrying that string into the
// model would let it match a search, sort as text, and render as content.
type FactValue = { readonly kind: "known"; readonly text: string } | { readonly kind: "unknown" }

const UNKNOWN_TEXT = "—"
// A job-apply stub carries no `## Provenance`: flow-record.md:79 forbids
// fabricating one. The absence is meaningful — nobody's pack found it — so it
// reads as its own source rather than an em dash in the tally.
const DIRECT_APPLY = "direct-apply"

// The one place an unknown becomes a glyph.
const factText = (value: FactValue): string => (value.kind === "known" ? value.text : UNKNOWN_TEXT)

type Score = { readonly kind: "scored"; readonly value: number } | { readonly kind: "unscored" }

type Excerpt = { readonly kind: "printed"; readonly text: string } | { readonly kind: "absent" }

type Posting = { readonly kind: "live" } | { readonly kind: "dead"; readonly since: IsoDate }

type Factor = { readonly label: string; readonly points: FactValue }

// No free-text `why`: across the corpus it mostly restated provenance.source,
// jd_date, or the score factors, and the one thing it alone carried — the pack
// query — is now provenance.matchedQuery.
type Verdict = { readonly factors: readonly Factor[] }

// Copied from the posting, never summarized. Empty means the page printed no
// such section; the sheet renders nothing rather than a placeholder.
type Role = {
  readonly snapshot: string
  readonly responsibilities: readonly string[]
  readonly requirements: readonly string[]
}

type LogEntry = {
  readonly date: IsoDate
  readonly event: string
  readonly writer: Writer
}

type Provenance = {
  readonly source: string
  readonly author: FactValue
  readonly contact: FactValue
  readonly matchedQuery: FactValue
  readonly date: string
}

type Dossier = {
  readonly file: string
  readonly company: string
  readonly title: string
  readonly url: string
  readonly host: string
  readonly status: Lifecycle
  readonly firstSeen: IsoDate
  readonly lastSeen: IsoDate
  readonly score: Score
  readonly bucket: Bucket
  readonly channel: Channel
  readonly verdict: Verdict
  readonly facts: Readonly<Record<FactKey, FactValue>>
  readonly role: Role
  // Legacy. Scout no longer writes `## From the posting`, and the sheet shows
  // this only when `role` is empty — so dossiers written before the redesign
  // keep their prose until scout next opens them.
  readonly excerpt: Excerpt
  readonly provenance: Provenance
  readonly log: readonly LogEntry[]
  readonly posting: Posting
  readonly applications: number
}

/* -- parse failure -------------------------------------------------------- */

// Discriminated, so the gaps list can group by cause instead of matching prose.
type ParseError = {
  readonly file: string
  readonly at: string
  readonly cause:
    | { readonly kind: "frontmatter"; readonly detail: string }
    | {
        readonly kind: "vocabulary"
        readonly field: string
        readonly got: string
      }
    | { readonly kind: "section"; readonly heading: string }
    | { readonly kind: "table"; readonly detail: string }
    | { readonly kind: "date"; readonly field: string; readonly got: string }
    | {
        readonly kind: "score-mismatch"
        readonly frontmatter: string
        readonly table: string
      }
    | { readonly kind: "unreadable"; readonly detail: string }
}

type ParsedDossier = Result<Dossier, ParseError>

/* -- store (client corpus snapshot; no absolute paths) -------------------- */

type Store =
  | {
      readonly kind: "ready"
      readonly label: string
      readonly generatedAt: string
      readonly dossiers: readonly Dossier[]
      // Flat skill names from the profile's data/skills.yaml. Empty when that
      // file is absent or unreadable — Stack then renders every token unmarked.
      readonly skills: readonly string[]
      readonly gaps: readonly ParseError[]
    }
  | {
      readonly kind: "wrong-root"
      readonly label: string
      readonly missing: readonly string[]
    }

/* -- trash outcomes ------------------------------------------------------- */

type TrashFailure = { readonly file: string; readonly reason: string }

type Trashed = {
  readonly moved: readonly string[]
  readonly failed: readonly TrashFailure[]
}

type TrashOpError =
  | { readonly kind: "not-allowed" }
  | { readonly kind: "stale" }
  | { readonly kind: "jobs-missing" }
  | { readonly kind: "failed"; readonly detail: string }
