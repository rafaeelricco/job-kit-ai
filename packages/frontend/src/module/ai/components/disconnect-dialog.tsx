export { DisconnectDialog }

import { useState } from "react"

import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { api } from "@api/endpoints"
import { call, fetchErrorToString, type FetchError } from "@api/request"
import { Failed, Loading, NotAsked, type RemoteData } from "@lib/remote-data"
import { Alert, AlertDescription } from "@ui/alert"
import { Button } from "@ui/button"
import { Dialog, DialogContent, DialogTitle } from "@ui/dialog"
import { ScrollArea } from "@ui/scroll-area"

import { PROVIDER_COPY } from "@module/ai/providers"
import { type AiSetupView, type ConnectionView } from "@module/ai/types"

/** S6 — a confirm dialog over the active connection. Confirming falls the panel back to S7 (no active connection). */
function DisconnectDialog({
  connection,
  onSetup,
  onClose,
}: {
  readonly connection: ConnectionView
  readonly onSetup: (setup: AiSetupView) => void
  readonly onClose: () => void
}) {
  const [submit, setSubmit] = useState<RemoteData<FetchError, void>>(NotAsked())
  const name = PROVIDER_COPY[connection.provider].name

  const handleDisconnect = (): void => {
    if (submit.isLoading) return
    setSubmit(Loading())
    call(api.disconnectAi, { connectionId: connection.connectionId }).fork(
      (error) => setSubmit(Failed(error)),
      ({ setup }) => {
        setSubmit(NotAsked())
        onSetup(setup)
        onClose()
      }
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submit.isLoading) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-4rem)] gap-0 p-0 sm:max-w-[440px]">
        <ScrollArea viewportProps={{ className: "h-auto max-h-[calc(100dvh-4rem)]" }}>
          <div className="flex items-start justify-between gap-3 px-7 pt-6">
            <DialogTitle className="text-base leading-none font-semibold">Disconnect {name}?</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              disabled={submit.isLoading}
              onClick={onClose}
            >
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          </div>
          <div className="flex flex-col gap-4 px-7 py-5">
            <p className="text-sm leading-relaxed text-ink-body">
              Job Kit deletes your {name} credentials. Until you connect another AI, it can&apos;t draft your profile or
              match new postings. Your confirmed profile and dossiers stay.
            </p>
            {submit instanceof Failed ?
              <Alert variant="destructive">
                <AlertDescription>{fetchErrorToString(submit.error)}</AlertDescription>
              </Alert>
            : null}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-divider px-7 py-3.5">
            <Button type="button" variant="ghost" disabled={submit.isLoading} onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={submit.isLoading} onClick={handleDisconnect}>
              {submit.isLoading ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
