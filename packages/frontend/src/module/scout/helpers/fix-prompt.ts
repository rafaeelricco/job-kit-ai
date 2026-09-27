export { toFixPrompt }

import { assertNever } from "@module/scout/result"
import { type ParseError } from "@module/scout/types"

// No /job-fix skill. Point at profile root + schema home; do not restate schema.
function toFixPrompt(gaps: readonly ParseError[]): string {
  const noun = gaps.length === 1 ? "dossier" : "dossiers"
  return [
    "/job-profile-root, then repair these files under scout/jobs/ so they parse.",
    "STOP if a listed file is missing there. Invent no facts.",
    "Shape: job-store references/schemas/schema-dossier.md — do not run /job-scout.",
    "",
    `${gaps.length} ${noun} failed:`,
    ...gaps.map((gap) => `- ${gap.file} — at ${gap.at} — ${describe(gap.cause)}`),
  ].join("\n")
}

function describe(cause: ParseError["cause"]): string {
  switch (cause.kind) {
    case "frontmatter":
      return `frontmatter: ${cause.detail}`
    case "vocabulary":
      return `vocabulary: ${cause.field} got "${cause.got}"`
    case "section":
      return `section: missing ${cause.heading}`
    case "table":
      return `table: ${cause.detail}`
    case "date":
      return `date: ${cause.field} got "${cause.got}"`
    case "score-mismatch":
      return `score mismatch: frontmatter ${cause.frontmatter}, table ${cause.table}`
    case "unreadable":
      return `unreadable: ${cause.detail}`
    default:
      return assertNever(cause)
  }
}
