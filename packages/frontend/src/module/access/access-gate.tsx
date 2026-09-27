export { AccessGate, LoadingRows }

import { useState } from "react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { type ReactNode } from "react"
import { Skeleton } from "@ui/skeleton"
import { ConsentDialog } from "@module/access/consent-dialog"
import { PermissionEmpty } from "@module/access/permission-empty"
import { useAccess } from "@module/access/use-access"

// The ladder both gates open on: hydrating -> permission -> consent -> granted.
// `chrome` is "page" for a route (Shell paints the h1 and page padding) and
// "bare" inside the settings dialog, which paints its own panel header.
function AccessGate({
  title,
  Icon,
  chrome = "page",
  children,
}: {
  readonly title: string
  readonly Icon: IconSvgElement
  readonly chrome?: "page" | "bare"
  readonly children: () => ReactNode
}) {
  const { state: access, pick, request } = useAccess()
  // Dismissing the dialog is not a dead end — the empty state reopens it.
  const [asking, setAsking] = useState(true)

  if (access.kind === "hydrating") {
    return chrome === "bare" ?
        <LoadingRows />
      : <Shell title={title} Icon={Icon}>
          <LoadingRows />
        </Shell>
  }

  if (access.kind !== "granted") {
    return (
      <>
        <PermissionEmpty
          kind={access.kind}
          onPrimary={() => {
            if (access.kind === "prompt") void request()
            else void pick()
          }}
          {...(access.kind === "no-handle" ? { onReview: () => setAsking(true) } : {})}
        />
        <ConsentDialog
          open={access.kind === "no-handle" && asking}
          onOpenChange={setAsking}
          onAllow={() => {
            void pick()
          }}
        />
      </>
    )
  }

  return chrome === "bare" ?
      <>{children()}</>
    : <Shell title={title} Icon={Icon}>
        {children()}
      </Shell>
}

function Shell({
  title,
  Icon,
  children,
}: {
  readonly title: string
  readonly Icon: IconSvgElement
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col gap-6 px-6 py-6">
      <h1 className="flex items-center gap-2 text-xl font-medium">
        <HugeiconsIcon icon={Icon} className="size-5" aria-hidden="true" />
        {title}
      </h1>
      {children}
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 8 }, (_, row) => (
        <Skeleton key={row} className="h-14 w-full" />
      ))}
    </div>
  )
}
