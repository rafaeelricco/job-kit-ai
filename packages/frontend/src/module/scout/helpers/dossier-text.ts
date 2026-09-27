export { toDossierText }

import { type Dossier } from "@module/scout/types"
import { FACT_KEYS, FACT_LABELS, factText } from "@module/scout/types"

// Mirrors DossierSheet in its own reading order. The exporters in export.ts
// project a fixed column set for a list; this one is the whole of one job,
// which is what the sheet shows and what a copy is expected to carry.
function toDossierText(d: Dossier): string {
  const total = d.score.kind === "scored" ? String(d.score.value) : factText({ kind: "unknown" })
  const emptyRole = d.role.snapshot === "" && d.role.responsibilities.length === 0 && d.role.requirements.length === 0

  return [
    `# ${d.company} — ${d.title}`,
    `${d.host} · ${d.url}`,
    ...(d.posting.kind === "dead" ? ["", `Posting marked dead since ${d.posting.since}.`] : []),
    "",
    ...(d.role.snapshot === "" ? [] : ["## The role", d.role.snapshot, ""]),
    ...(d.role.responsibilities.length === 0 ?
      []
    : ["## What you'd do", ...d.role.responsibilities.map((item) => `- ${item}`), ""]),
    ...(d.role.requirements.length === 0 ?
      []
    : ["## Must have", ...d.role.requirements.map((item) => `- ${item}`), ""]),
    ...(d.facts.required_skills.kind === "known" ? ["## Stack", factText(d.facts.required_skills), ""] : []),
    // Same legacy branch the sheet takes: prose from before scout wrote roles.
    ...(emptyRole && d.excerpt.kind === "printed" ? ["## From the posting", d.excerpt.text, ""] : []),
    "## Score",
    ...d.verdict.factors.map((factor) => `- ${factor.label}: ${factText(factor.points)}`),
    `- Total: ${total}`,
    "",
    "## Facts",
    // A value the posting never printed gets no line, exactly as in the sheet.
    ...FACT_KEYS.filter((key) => d.facts[key].kind === "known").map(
      (key) => `- ${FACT_LABELS[key]}: ${factText(d.facts[key])}`
    ),
    "",
    "## Logs",
    `- Source: ${d.provenance.source}`,
    ...(d.provenance.author.kind === "known" ? [`- Author: ${factText(d.provenance.author)}`] : []),
    ...(d.provenance.contact.kind === "known" ? [`- Contact: ${factText(d.provenance.contact)}`] : []),
    ...(d.provenance.matchedQuery.kind === "known" ? [`- Pack query: ${factText(d.provenance.matchedQuery)}`] : []),
    `- Search date: ${d.provenance.date}`,
    ...(d.log.length === 0 ?
      ["- No entries"]
    : d.log.map((entry) => `- ${entry.date} — ${entry.event} (${entry.writer})`)),
  ].join("\n")
}
