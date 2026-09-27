export { ProfileGate }

import { type IconSvgElement } from "@hugeicons/react"
import { type ReactNode } from "react"
import { Alert, AlertDescription, AlertTitle } from "@ui/alert"
import { AccessGate, LoadingRows } from "@module/access/access-gate"
import { useAccess } from "@module/access/use-access"
import { ProfileGaps } from "@module/profile/components/gaps"
import { useProfile } from "@module/profile/helpers/use-profile"
import { type Save } from "@module/profile/helpers/use-profile"
import { type Profile } from "@module/profile/types"
import { WrongRoot } from "@module/scout/components/store-gate"
import { assertNever } from "@module/scout/result"

// All three profile sections open on the same ladder — access, load, fail,
// resolve — and only diverge once a parsed profile exists.
function ProfileGate({
  title,
  Icon,
  chrome,
  children,
}: {
  readonly title: string
  readonly Icon: IconSvgElement
  readonly chrome?: "page" | "bare"
  readonly children: (profile: Profile, save: Save) => ReactNode
}) {
  return (
    <AccessGate title={title} Icon={Icon} {...(chrome === undefined ? {} : { chrome })}>
      {() => <Loaded>{children}</Loaded>}
    </AccessGate>
  )
}

// useProfile must sit below AccessGate rather than beside it: it may only run
// once access is granted, which is exactly what the gate has already proven.
function Loaded({ children }: { readonly children: (profile: Profile, save: Save) => ReactNode }) {
  const { state, save, reload } = useProfile()
  const { changeFolder } = useAccess()

  switch (state.kind) {
    case "loading":
      return <LoadingRows />
    case "read-failed":
      return (
        <Alert variant="destructive">
          <AlertTitle>Could not read the folder</AlertTitle>
          <AlertDescription>{state.detail}</AlertDescription>
        </Alert>
      )
    case "wrong-root":
      return (
        <WrongRoot
          label={state.label}
          missing={state.missing}
          onRepick={() => {
            void changeFolder().then((result) => {
              if (result.kind === "ok") reload()
            })
          }}
        />
      )
    case "loaded":
      return (
        <>
          <ProfileGaps gaps={state.profile.gaps} />
          {children(state.profile, save)}
        </>
      )
    default:
      return assertNever(state)
  }
}
