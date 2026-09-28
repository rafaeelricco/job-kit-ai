export { SwitchConfirm, SwitchConfirmDialog }

import { useState } from "react"

import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { api } from "@api/endpoints"
import { BadStatus, call, fetchErrorToString, type FetchError } from "@api/request"
import { Failed, Loading, NotAsked, type RemoteData } from "@lib/remote-data"
import { Alert, AlertDescription } from "@ui/alert"
import { Button } from "@ui/button"
import { Dialog, DialogContent, DialogTitle } from "@ui/dialog"
import { ScrollArea } from "@ui/scroll-area"

import { methodLabel, PROVIDER_COPY } from "@module/ai/providers"
import { type AiSetupView, type ConnectionView } from "@module/ai/types"

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

/**
 * S5's content only — no `Dialog` of its own, so `ConnectDialog` can drop it straight into its own frame when a
 * connect flow lands on a staged switch. `SwitchConfirmDialog` below wraps it for standalone use (the settings
 * panel, or a staged connection found on load).
 */
function SwitchConfirm({
  current,
  staged,
  onSetup,
  onDone,
}: {
  readonly current: ConnectionView | null
  readonly staged: ConnectionView
  readonly onSetup: (setup: AiSetupView) => void
  readonly onDone: () => void
}) {
  const [submit, setSubmit] = useState<RemoteData<FetchError, void>>(NotAsked())

  const newName = PROVIDER_COPY[staged.provider].name
  const oldName = current !== null ? PROVIDER_COPY[current.provider].name : null

  const run = (endpoint: typeof api.confirmAiSwitch | typeof api.discardAiSwitch): void => {
    if (submit.isLoading) return
    setSubmit(Loading())
    call(endpoint, { connectionId: staged.connectionId }).fork(
      (error) => setSubmit(Failed(error)),
      ({ setup }) => {
        setSubmit(NotAsked())
        onSetup(setup)
        onDone()
      }
    )
  }

  const keep = (): void => run(api.discardAiSwitch)
  const switchTo = (): void => run(api.confirmAiSwitch)

  const errorMessage =
    submit instanceof Failed ?
      submit.error instanceof BadStatus && submit.error.status === 409 ?
        `${newName} stopped passing its check. Keep ${oldName ?? "the current connection"} or try again.`
      : fetchErrorToString(submit.error)
    : null

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between gap-3 px-7 pt-6">
        <DialogTitle className="text-base leading-none font-semibold">Switch to {newName}?</DialogTitle>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          disabled={submit.isLoading}
          onClick={keep}
        >
          <HugeiconsIcon icon={Cancel01Icon} />
        </Button>
      </div>
      <div className="flex flex-col gap-4 px-7 py-5">
        {/* No live region: inside `ConnectDialog` its own status region announces this; standalone, opening the
            dialog moves focus into it. */}
        <ul className="flex flex-col gap-2.5">
          <li className="flex items-start gap-2.5">
            <HugeiconsIcon icon={Tick02Icon} className="mt-0.5 size-4 text-success" aria-hidden="true" />
            <div>
              <div className="text-sm text-ink-strong">{newName} connected and tested</div>
              <div className="text-xs text-ink-soft">
                {methodLabel(staged.provider, staged.method)} · <span className="font-mono">{staged.account}</span>
              </div>
            </div>
          </li>
        </ul>
        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-muted">Billed to</dt>
          <dd>
            {current !== null ?
              <span className="block text-ink-soft line-through">{current.billing}</span>
            : null}
            {staged.billing}
          </dd>
          <dt className="text-ink-muted">Model</dt>
          <dd>
            Recommended <span className="font-mono text-xs text-ink-soft">{staged.preferences.model}</span>
          </dd>
          <dt className="text-ink-muted">Effort</dt>
          <dd>{capitalize(staged.preferences.effort)}</dd>
        </dl>
        <p className="text-sm leading-relaxed text-ink-body">
          {current !== null && oldName !== null ?
            `New drafts and matches use ${newName}. Work already running on ${oldName} finishes there. Your ${oldName} credentials are deleted from Job Kit.`
          : `New drafts and matches use ${newName}.`}
        </p>
        {errorMessage !== null ?
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-divider px-7 py-3.5">
        <Button type="button" variant="ghost" disabled={submit.isLoading} onClick={keep}>
          Keep {oldName ?? "current"}
        </Button>
        <Button type="button" disabled={submit.isLoading} onClick={switchTo}>
          Switch to {newName}
        </Button>
      </div>
    </div>
  )
}

/** Standalone wrapper for the settings panel: its own switch picker, and a staged connection surviving a refresh. */
function SwitchConfirmDialog({
  open,
  onOpenChange,
  current,
  staged,
  onSetup,
  onDone,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly current: ConnectionView | null
  readonly staged: ConnectionView
  readonly onSetup: (setup: AiSetupView) => void
  readonly onDone: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-4rem)] gap-0 p-0 sm:max-w-[460px]">
        <ScrollArea viewportProps={{ className: "h-auto max-h-[calc(100dvh-4rem)]" }}>
          <SwitchConfirm current={current} staged={staged} onSetup={onSetup} onDone={onDone} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
