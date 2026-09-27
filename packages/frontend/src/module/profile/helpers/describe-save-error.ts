export { describeSaveError }

import { type SaveError } from "@module/profile/helpers/write-profile"
import { assertNever } from "@module/scout/result"

// Save-failure copy lives beside the save helpers rather than in one surface:
// every component that calls save reports the same five failures the same way.
function describeSaveError(error: SaveError): string {
  switch (error.kind) {
    case "missing":
      return `data/${error.file} is no longer in the profile folder.`
    case "invalid":
      return `data/${error.file} could not be parsed: ${error.detail}`
    case "stale":
      return `data/${error.file} changed on disk after this page loaded. Reload the page, then make the change again.`
    case "not-allowed":
      return "The browser withdrew permission to write to the profile folder. Reload the page and allow it again."
    case "failed":
      return `Save failed: ${error.detail}`
    default:
      return assertNever(error)
  }
}
