export { StoreGate, type Ready, WrongRoot }

import { type IconSvgElement } from "@hugeicons/react"
import { type ReactNode } from "react"
import { Alert, AlertDescription, AlertTitle } from "@ui/alert"
import { Button } from "@ui/button"
import { AccessGate, LoadingRows } from "@module/access/access-gate"
import { useAccess } from "@module/access/use-access"
import { useStore } from "@module/scout/helpers/use-store"
import { type StoreState } from "@module/scout/helpers/use-store"
import { assertNever } from "@module/scout/result"
import { type Result } from "@module/scout/result"
import { type Store, type TrashOpError, type Trashed } from "@module/scout/types"

type Ready = Extract<Store, { kind: "ready" }>

type StoreActions = {
  readonly reload: () => void
  readonly trash: (files: readonly string[]) => Promise<Result<Trashed, TrashOpError>>
}

// Both Home and Dossiers open on the same ladder — access, load, fail, resolve —
// and only diverge once a ready store exists.
function StoreGate({
  title,
  Icon,
  children,
}: {
  readonly title: string
  readonly Icon: IconSvgElement
  readonly children: (store: Ready, actions: StoreActions) => ReactNode
}) {
  return (
    <AccessGate title={title} Icon={Icon}>
      {() => <Loaded>{children}</Loaded>}
    </AccessGate>
  )
}

// useStore must sit below AccessGate rather than beside it: it may only run
// once access is granted, which is exactly what the gate has already proven.
function Loaded({ children }: { readonly children: (store: Ready, actions: StoreActions) => ReactNode }) {
  const { state, reload, trash } = useStore(true)
  const { changeFolder } = useAccess()

  return (
    <Resolved
      state={state}
      reload={reload}
      trash={trash}
      onRepick={() => {
        void changeFolder().then((result) => {
          if (result.kind === "ok") reload()
        })
      }}
    >
      {children}
    </Resolved>
  )
}

function Resolved({
  state,
  reload,
  trash,
  onRepick,
  children,
}: {
  readonly state: StoreState
  readonly reload: () => void
  readonly trash: (files: readonly string[]) => Promise<Result<Trashed, TrashOpError>>
  readonly onRepick: () => void
  readonly children: (store: Ready, actions: StoreActions) => ReactNode
}) {
  switch (state.kind) {
    case "idle":
    case "loading":
      return <LoadingRows />
    case "read-failed":
      return (
        <Alert variant="destructive">
          <AlertTitle>Could not read the folder</AlertTitle>
          <AlertDescription>{state.detail}</AlertDescription>
        </Alert>
      )
    case "loaded":
      return state.store.kind === "wrong-root" ?
          <WrongRoot label={state.store.label} missing={state.store.missing} onRepick={onRepick} />
        : children(state.store, { reload, trash })
    default:
      return assertNever(state)
  }
}

function WrongRoot({
  label,
  missing,
  onRepick,
}: {
  readonly label: string
  readonly missing: readonly string[]
  readonly onRepick: () => void
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>Not a job-kit profile folder</AlertTitle>
      <AlertDescription>
        <p className="pt-1">
          <span className="font-mono text-xs">{label}</span> is missing required files:
        </p>
        <ul className="my-2 space-y-1 font-mono text-xs">
          {missing.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <p className="pb-3">
          Choose the profile root — the folder that contains <code>data/</code>.
        </p>
        <Button size="sm" onClick={onRepick}>
          Choose a different folder
        </Button>
      </AlertDescription>
    </Alert>
  )
}
