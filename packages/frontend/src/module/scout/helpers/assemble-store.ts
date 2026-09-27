export { toStore }

import { probe } from "@module/scout/helpers/probe"
import { type ProbeFiles } from "@module/scout/helpers/probe"
import { partition } from "@module/scout/result"
import { type ParsedDossier, type Store } from "@module/scout/types"

function toStore(
  label: string,
  generatedAt: string,
  files: ProbeFiles,
  parsed: readonly ParsedDossier[],
  skills: readonly string[]
): Store {
  const checked = probe(files)
  if (checked.kind === "failed") {
    return { kind: "wrong-root", label, missing: checked.missing }
  }
  const { values, errors } = partition(parsed)
  return { kind: "ready", label, generatedAt, dossiers: values, skills, gaps: errors }
}
