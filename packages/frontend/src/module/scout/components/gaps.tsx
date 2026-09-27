export { Gaps }

import { Alert, AlertDescription, AlertTitle } from "@ui/alert"
import { CopyButton } from "@ui/copy"
import { toFixPrompt } from "@module/scout/helpers/fix-prompt"
import { type ParseError } from "@module/scout/types"

// Name the gaps here; Copy fix hands repair to an agent via /job-profile-root.
function Gaps({ gaps }: { readonly gaps: readonly ParseError[] }) {
  if (gaps.length === 0) return null

  return (
    <Alert>
      <AlertTitle>{gaps.length.toLocaleString()} files did not parse</AlertTitle>
      <AlertDescription>
        <ul className="my-2 space-y-1 font-mono text-xs">
          {gaps.map((gap) => (
            <li key={gap.file}>
              {gap.file} · {gap.cause.kind} at {gap.at}
            </li>
          ))}
        </ul>
        <CopyButton value={() => toFixPrompt(gaps)} label="Copy fix prompt" />
      </AlertDescription>
    </Alert>
  )
}
