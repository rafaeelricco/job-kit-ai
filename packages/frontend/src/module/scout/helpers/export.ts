export { download, toCsv, toJson, toMarkdown }

import { type Dossier } from "@module/scout/types"

// Header names match the previous viewer, including "route" for the bucket.
const COLUMNS = [
  "company",
  "title",
  "score",
  "route",
  "channel",
  "status",
  "posting",
  "first_seen",
  "last_seen",
  "url",
] as const

const cells = (d: Dossier): readonly string[] => [
  d.company,
  d.title,
  d.score.kind === "scored" ? String(d.score.value) : "",
  d.bucket,
  d.channel,
  d.status,
  d.posting.kind === "live" ? "live" : `dead ${d.posting.since}`,
  d.firstSeen,
  d.lastSeen,
  d.url,
]

/* -- csv ------------------------------------------------------------------ */

// A leading =, +, -, @, tab, or CR makes a spreadsheet treat the cell as a
// formula. The apostrophe forces it back to text.
const RISKY_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"])

const csvCell = (raw: string): string => {
  const lead = raw.charAt(0)
  const guarded = RISKY_LEAD.has(lead) ? `'${raw}` : raw
  return /[",\n\r]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded
}

function toCsv(rows: readonly Dossier[]): string {
  const lines = [COLUMNS.map(csvCell).join(","), ...rows.map((d) => cells(d).map(csvCell).join(","))]
  return lines.join("\n")
}

/* -- json ----------------------------------------------------------------- */

function toJson(rows: readonly Dossier[]): string {
  return JSON.stringify(rows, null, 2)
}

/* -- markdown ------------------------------------------------------------- */

// A bare pipe would end the cell and shift every column after it.
const mdCell = (raw: string): string => raw.replaceAll("|", "\\|")

const mdRow = (values: readonly string[]): string => `| ${values.map(mdCell).join(" | ")} |`

function toMarkdown(rows: readonly Dossier[]): string {
  const lines = [mdRow(COLUMNS), `| ${COLUMNS.map(() => "---").join(" | ")} |`, ...rows.map((d) => mdRow(cells(d)))]
  return lines.join("\n")
}

/* -- download ------------------------------------------------------------- */

// Writes to the browser's downloads only. Nothing here touches the profile
// store on disk.
function download(name: string, mime: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: mime }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
