export { AiPanel }

import { useState } from "react"
import { Link } from "react-router-dom"

import { api } from "@api/endpoints"
import { call, fetchErrorToString, type FetchError } from "@api/request"
import { Failed, Loading, NotAsked, Ready, type RemoteData } from "@lib/remote-data"
import { POSIX } from "@lib/time"
import { cn } from "@components/utils"
import { LoadingRows } from "@module/access/access-gate"
import { assertNever } from "@module/scout/result"
import { Alert, AlertDescription } from "@ui/alert"
import { Button } from "@ui/button"
import { Label } from "@ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select"
import { toast } from "sonner"
import { ToggleGroup, ToggleGroupItem } from "@ui/toggle-group"

import { ConnectDialog, type ConnectRequest } from "@module/ai/components/connect-dialog"
import { DisconnectDialog } from "@module/ai/components/disconnect-dialog"
import { ProviderMark } from "@module/ai/components/provider-mark"
import { ProviderPicker } from "@module/ai/components/provider-picker"
import { SwitchConfirmDialog } from "@module/ai/components/switch-confirm"
import { methodLabel, openProviderTab, opensTab, PROVIDER_COPY } from "@module/ai/providers"
import {
  type AiSetupView,
  type ConnectionStatus,
  type ConnectionView,
  type Effort,
  type Model,
  type Provider,
  type Purpose,
} from "@module/ai/types"
import { useAiSetup } from "@module/ai/use-ai-setup"

const LABEL_CLASS = "text-xs leading-none font-normal text-ink-soft"
const HINT_CLASS = "text-[11px] leading-normal text-ink-faint"

// ---------------------------------------------------------------------------------------------------------------
// Connection status copy
// ---------------------------------------------------------------------------------------------------------------

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

/** `checkedAt` is always in the past here, so `Intl.RelativeTimeFormat` always reads "N units ago". */
function relativeTime(checkedAt: POSIX): string {
  const seconds = checkedAt.difference(POSIX.now()).asSeconds()
  const abs = Math.abs(seconds)
  if (abs < 60) return RELATIVE_TIME.format(Math.round(seconds), "second")
  const minutes = seconds / 60
  if (Math.abs(minutes) < 60) return RELATIVE_TIME.format(Math.round(minutes), "minute")
  const hours = minutes / 60
  if (Math.abs(hours) < 24) return RELATIVE_TIME.format(Math.round(hours), "hour")
  return RELATIVE_TIME.format(Math.round(hours / 24), "day")
}

/** `true` for every status the connection card and settings panel treat as "needs attention" (S3). */
function needsAttention(status: ConnectionStatus): status is Exclude<ConnectionStatus, "ready"> {
  return status !== "ready"
}

function statusLabel(status: ConnectionStatus, checkedAt: POSIX): string {
  switch (status) {
    case "ready":
      return `Connected · checked ${relativeTime(checkedAt)}`
    case "revoked":
      return "Access revoked"
    case "expired":
      return "Sign-in expired"
    case "quota_exhausted":
      return "Usage limit reached"
    case "unreachable":
      return "Not responding"
    default:
      return assertNever(status)
  }
}

/** The S3 alert's bold lead-in sentence, by status. */
function attentionSentence(provider: Provider, status: Exclude<ConnectionStatus, "ready">): string {
  const name = PROVIDER_COPY[provider].name
  switch (status) {
    case "revoked":
      return `${name} stopped accepting Job Kit's requests.`
    case "expired":
      return `${name}'s sign-in expired.`
    case "quota_exhausted":
      return `${name} has reached its usage limit.`
    case "unreachable":
      return `${name} isn't responding.`
    default:
      return assertNever(status)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Connection section (S1 / S3 / S7)
// ---------------------------------------------------------------------------------------------------------------

function NotConnected({ onConnect }: { readonly onConnect: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2.5 border border-dashed border-divider-emphasis p-6">
      <div className="font-medium text-ink-strong">No AI connected</div>
      <p className="text-[13px] leading-relaxed text-ink-soft">
        Profile drafts and new matches are paused. Connect OpenAI, Anthropic or xAI to continue.
      </p>
      <Button type="button" size="sm" className="h-8 px-3" onClick={onConnect}>
        Connect an AI
      </Button>
    </div>
  )
}

function ConnectionCard({
  connection,
  onSwitch,
  onReconnect,
  onDisconnect,
  replace,
}: {
  readonly connection: ConnectionView
  readonly onSwitch: () => void
  readonly onReconnect: () => void
  readonly onDisconnect: () => void
  readonly replace: (setup: AiSetupView) => void
}) {
  const [test, setTest] = useState<RemoteData<FetchError, void>>(NotAsked())
  const attention = needsAttention(connection.status)

  const runTest = (): void => {
    if (test.isLoading) return
    setTest(Loading())
    call(api.testAiConnection, { connectionId: connection.connectionId }).fork(
      (error) => setTest(Failed(error)),
      ({ setup }) => {
        setTest(NotAsked())
        replace(setup)
      }
    )
  }

  return (
    <div className="flex flex-col gap-3 border border-divider bg-surface p-4">
      {needsAttention(connection.status) ?
        <Alert variant="destructive">
          <AlertDescription>
            <strong className="font-medium text-destructive">
              {attentionSentence(connection.provider, connection.status)}
            </strong>{" "}
            New drafts and matches wait until you reconnect. Your profile and dossiers are safe.
          </AlertDescription>
        </Alert>
      : null}

      <div className="flex items-center gap-3">
        <ProviderMark provider={connection.provider} />
        <div className="flex-1">
          <div className="font-medium text-ink-strong">{PROVIDER_COPY[connection.provider].name}</div>
          <div className="text-xs text-ink-soft">{methodLabel(connection.provider, connection.method)}</div>
        </div>
        <span
          role="status"
          className={cn("inline-flex items-center gap-1.5 text-xs", attention ? "text-destructive" : "text-ink-body")}
        >
          <span aria-hidden="true" className={cn("size-2 rounded-full", attention ? "bg-destructive" : "bg-success")} />
          {statusLabel(connection.status, connection.checkedAt)}
        </span>
      </div>

      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        <dt className="text-ink-muted">Account</dt>
        <dd className="font-mono">{connection.account}</dd>
        <dt className="text-ink-muted">Billed to</dt>
        <dd className="text-ink-body">{connection.billing}</dd>
      </dl>

      {test instanceof Failed ?
        <Alert variant="destructive">
          <AlertDescription>{fetchErrorToString(test.error)}</AlertDescription>
        </Alert>
      : null}

      <div className="flex flex-wrap items-center gap-2">
        {attention ?
          <Button type="button" size="sm" className="h-8 px-3" onClick={onReconnect}>
            Reconnect
          </Button>
        : null}
        <Button type="button" size="sm" variant="outline" className="h-8 px-3" onClick={onSwitch}>
          Switch provider
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 px-3"
          disabled={test.isLoading}
          onClick={runTest}
        >
          {test.isLoading ? "Testing…" : "Test connection"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-8 px-3 text-destructive hover:text-destructive"
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
    </div>
  )
}

function ConnectionSection({
  setup,
  onConnect,
  onSwitch,
  onReconnect,
  onDisconnect,
  replace,
}: {
  readonly setup: AiSetupView
  readonly onConnect: () => void
  readonly onSwitch: () => void
  readonly onReconnect: () => void
  readonly onDisconnect: () => void
  readonly replace: (setup: AiSetupView) => void
}) {
  return (
    <div className="space-y-2">
      <Label className={LABEL_CLASS}>Connection</Label>
      {setup.active === null ?
        <NotConnected onConnect={onConnect} />
      : <ConnectionCard
          key={setup.active.connectionId.value}
          connection={setup.active}
          onSwitch={onSwitch}
          onReconnect={onReconnect}
          onDisconnect={onDisconnect}
          replace={replace}
        />
      }
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Model + reasoning effort (S1 / S2 / S7's disabled field)
// ---------------------------------------------------------------------------------------------------------------

function DisconnectedModelField() {
  return (
    <div className="space-y-2">
      <Label className={LABEL_CLASS}>Model</Label>
      <Select value="" disabled>
        <SelectTrigger className="h-9 w-full max-w-sm justify-between px-3 text-sm">
          <SelectValue placeholder="Connect an AI first" />
        </SelectTrigger>
        <SelectContent />
      </Select>
    </div>
  )
}

const EFFORT_OPTIONS: readonly { readonly value: Effort; readonly label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

const isEffort = (value: string): value is Effort => EFFORT_OPTIONS.some((option) => option.value === value)

/** The current model, falling back to the recommended one, then the first — the same rule `defaultPreferences` uses. */
function pickModel(models: readonly Model[], id: string): Model | undefined {
  return models.find((m) => m.id === id) ?? models.find((m) => m.recommended) ?? models[0]
}

/**
 * S1/S2's Model select + Reasoning effort toggle + Save/Reset row, one local draft keyed (by the caller) on the
 * active connection id and its saved preferences, so a switch, or a reconnect that keeps the id but resets the
 * preferences, re-seeds it. Mirrors `useCardSave`/`SaveButton`
 * (`settings-surface.tsx:97-151`): a `RemoteData<FetchError, void>` submit cell, both actions disabled until dirty.
 */
function ModelAndEffort({
  connection,
  replace,
}: {
  readonly connection: ConnectionView
  readonly replace: (setup: AiSetupView) => void
}) {
  const [model, setModel] = useState(connection.preferences.model)
  const [effort, setEffort] = useState<Effort>(connection.preferences.effort)
  const [submit, setSubmit] = useState<RemoteData<FetchError, void>>(NotAsked())

  const selected = pickModel(connection.models, model)
  const dirty = model !== connection.preferences.model || effort !== connection.preferences.effort

  const handleModelChange = (nextId: string | null): void => {
    if (nextId === null) return
    setModel(nextId)
    const next = connection.models.find((m) => m.id === nextId)
    if (next !== undefined && !next.efforts.includes(effort)) {
      setEffort(next.efforts.includes("medium") ? "medium" : (next.efforts[0] ?? effort))
    }
  }

  const handleSave = (): void => {
    if (submit.isLoading || !dirty) return
    setSubmit(Loading())
    call(api.setAiPreferences, { connectionId: connection.connectionId, model, effort }).fork(
      (error) => setSubmit(Failed(error)),
      ({ setup }) => {
        setSubmit(NotAsked())
        replace(setup)
        toast.success("Saved AI preferences")
      }
    )
  }

  const handleReset = (): void => {
    setModel(connection.preferences.model)
    setEffort(connection.preferences.effort)
    setSubmit(NotAsked())
  }

  return (
    <>
      <div className="space-y-2">
        <Label className={LABEL_CLASS}>Model</Label>
        <Select value={model} onValueChange={handleModelChange}>
          <SelectTrigger className="h-9 w-full max-w-sm justify-between px-3 text-sm">
            <SelectValue>
              {(value: string) => {
                const current = pickModel(connection.models, value)
                return current === undefined ? value : (
                    <span>
                      {current.recommended ? "Recommended " : null}
                      <span className="font-mono text-xs text-ink-soft">{current.id}</span>
                    </span>
                  )
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {connection.models.map((m) => (
              <SelectItem key={m.id} value={m.id} disabled={!m.usable}>
                <span className="flex flex-col py-0.5">
                  <span>
                    <span className="font-mono text-xs">{m.id}</span>
                    {m.recommended ?
                      <span className="ml-1.5 text-xs font-medium text-ink-body">· Recommended</span>
                    : null}
                  </span>
                  <span className="text-xs text-ink-soft">{m.usable ? m.summary : m.reason}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className={HINT_CLASS}>Only models your account can use and that pass Job Kit's checks are listed.</p>
      </div>

      <div className="space-y-2">
        <Label className={LABEL_CLASS}>Reasoning effort</Label>
        <ToggleGroup
          variant="outline"
          spacing={0}
          value={[effort]}
          onValueChange={(next) => {
            const first = next[0]
            if (first !== undefined && isEffort(first)) setEffort(first)
          }}
          aria-label="Reasoning effort"
          className="self-start"
        >
          {EFFORT_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              disabled={selected !== undefined && !selected.efforts.includes(option.value)}
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className={HINT_CLASS}>Higher effort is slower and uses more of your plan.</p>
      </div>

      <div className="space-y-2">
        {submit instanceof Failed ?
          <Alert variant="destructive">
            <AlertDescription>{fetchErrorToString(submit.error)}</AlertDescription>
          </Alert>
        : null}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            className="h-8 px-3"
            disabled={submit.isLoading || !dirty}
            onClick={handleSave}
          >
            {submit.isLoading ? "Saving…" : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 border-divider-emphasis bg-transparent px-3 text-ink-soft"
            disabled={submit.isLoading || !dirty}
            onClick={handleReset}
          >
            Reset
          </Button>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// AiPanel
// ---------------------------------------------------------------------------------------------------------------

type Overlay =
  | { readonly kind: "none" }
  | { readonly kind: "picker"; readonly purpose: "initial" | "switch" }
  | {
      readonly kind: "connect"
      readonly request: ConnectRequest
      readonly purpose: Purpose
      readonly tab: Window | null
    }
  | { readonly kind: "disconnect" }

function AiPanelContent({
  setup,
  replace,
}: {
  readonly setup: AiSetupView
  readonly replace: (setup: AiSetupView) => void
}) {
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" })
  const closeOverlay = (): void => setOverlay({ kind: "none" })

  const handleReconnect = (): void => {
    if (setup.active === null) return
    const { provider, method } = setup.active
    // Synchronous, inside the click handler: see `provider-picker.tsx`'s `pickRoute`.
    const tab = opensTab(method) ? openProviderTab() : null
    const request: ConnectRequest =
      method === "api_key" ? { kind: "apiKey", provider } : { kind: "route", route: { provider, method } }
    setOverlay({ kind: "connect", request, purpose: "reconnect", tab })
  }

  return (
    <div className="max-w-xl space-y-8">
      <ConnectionSection
        setup={setup}
        onConnect={() => setOverlay({ kind: "picker", purpose: "initial" })}
        onSwitch={() => setOverlay({ kind: "picker", purpose: "switch" })}
        onReconnect={handleReconnect}
        onDisconnect={() => setOverlay({ kind: "disconnect" })}
        replace={replace}
      />

      {setup.active === null ?
        <DisconnectedModelField />
      : <ModelAndEffort
          key={`${setup.active.connectionId.value}:${setup.active.preferences.model}:${setup.active.preferences.effort}`}
          connection={setup.active}
          replace={replace}
        />
      }

      <div>
        <Link
          to="/setup?step=overview"
          className="text-xs text-ink-soft underline underline-offset-3 hover:text-ink-strong"
        >
          Reopen the Job Kit overview
        </Link>
      </div>

      {overlay.kind === "picker" ?
        <ProviderPicker
          setup={setup}
          purpose={overlay.purpose}
          onClose={closeOverlay}
          onPick={(request, tab) => setOverlay({ kind: "connect", request, purpose: overlay.purpose, tab })}
        />
      : null}

      {overlay.kind === "connect" ?
        <ConnectDialog
          request={overlay.request}
          purpose={overlay.purpose}
          tab={overlay.tab}
          current={setup.active}
          onSetup={replace}
          onClose={closeOverlay}
        />
      : null}

      {overlay.kind === "disconnect" && setup.active !== null ?
        <DisconnectDialog connection={setup.active} onSetup={replace} onClose={closeOverlay} />
      : null}

      {/* A refresh mid-switch lands here with a staged connection and no local overlay open; reopen S5 for it. */}
      {overlay.kind === "none" && setup.staged !== null ?
        <SwitchConfirmDialog
          open
          onOpenChange={() => {}}
          current={setup.active}
          staged={setup.staged}
          onSetup={replace}
          onDone={closeOverlay}
        />
      : null}
    </div>
  )
}

/** S1–S7: the settings dialog's AI panel. Reads the same `useAiSetup()` cell as the onboarding wizard and the banner. */
function AiPanel() {
  const { state, replace } = useAiSetup()

  return (
    state instanceof Ready ? <AiPanelContent setup={state.value} replace={replace} />
    : state instanceof Loading || state instanceof NotAsked ? <LoadingRows />
    : state instanceof Failed ?
      <Alert variant="destructive">
        <AlertDescription>{fetchErrorToString(state.error)}</AlertDescription>
      </Alert>
    : (state satisfies never)
  )
}
