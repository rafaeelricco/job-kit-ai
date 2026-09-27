export { dossierName }

import { err, ok } from "@module/scout/result"
import { type Result } from "@module/scout/result"
import { type TrashFailure } from "@module/scout/types"

// Bare *.md basename only — same confine rule as former server/trash.ts.
function dossierName(file: string): Result<string, TrashFailure> {
  if (file.includes("/") || file.includes("\\") || !file.endsWith(".md") || file === ".md") {
    return err({ file, reason: "not a dossier name" })
  }
  return ok(file)
}
