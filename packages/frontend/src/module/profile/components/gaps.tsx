export { ProfileGaps }

import { Alert, AlertDescription, AlertTitle } from "@ui/alert"
import { type Profile } from "@module/profile/types"

// A file that did not parse leaves its section empty, which reads exactly like
// a file with nothing in it — the surfaces below even invite you to add rows
// the file already has. Naming the failure here is what tells the two apart.
function ProfileGaps({ gaps }: { readonly gaps: Profile["gaps"] }) {
  if (gaps.length === 0) return null

  return (
    <Alert variant="destructive">
      <AlertTitle>{gaps.length.toLocaleString()} files did not parse</AlertTitle>
      <AlertDescription>
        <p className="pt-1">Sections below are empty because these files could not be read:</p>
        <ul className="my-2 space-y-1 font-mono text-xs">
          {gaps.map((gap) => (
            <li key={gap.file}>
              {gap.file} · {gap.detail}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}
