export { ConnectDialog, type ConnectRequest }

import { useEffect, useRef, useState, type ReactNode } from "react"

import * as s from "@lib/json/schema"
import {
  Cancel01Icon,
  Copy01Icon,
  Loading03Icon,
  ArrowRight01Icon,
  LinkSquare02Icon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { api } from "@api/endpoints"
import { call, fetchErrorToString, type FetchError } from "@api/request"
import { Future, type Cancel } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { Ready } from "@lib/remote-data"
import { POSIX } from "@lib/time"
import { cn } from "@components/utils"
import { Alert, AlertDescription } from "@ui/alert"
import { Button, buttonVariants } from "@ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@ui/dialog"
import { CopyButton } from "@ui/copy"
import { Field, FieldDescription, FieldError, FieldLabel } from "@ui/field"
import { Input } from "@ui/input"
import { ScrollArea } from "@ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@ui/toggle-group"
import { checkApiKey } from "@be/domain/ai/keys"

import { ProviderMark } from "@module/ai/components/provider-mark"
import { SwitchConfirm } from "@module/ai/components/switch-confirm"
import { PROVIDER_COPY, PROVIDERS, openProviderTab, opensTab, routeAvailability } from "@module/ai/providers"
import {
  type AiSetupView,
  type AuthorizationStatus,
  type Challenge,
  type ConnectionView,
  type FailureReason,
  type Method,
  type Provider,
  type Purpose,
  type RouteView,
} from "@module/ai/types"
import { useAiSetup } from "@module/ai/use-ai-setup"

/** What the dialog is here to do: a fixed route's card, or the API-key form with a switchable provider. */
type ConnectRequest =
  { kind: "route"; route: { provider: Provider; method: Method } } | { kind: "apiKey"; provider: Provider }

type Route = { readonly provider: Provider; readonly method: Method }

/** `startAiAuthorization`'s response carries the concrete attempt id type; not part of the module's public `types.ts`. */
type AttemptId = s.Infer<typeof api.startAiAuthorization.response>["attemptId"]

/** A device challenge only — the `entry` variant never reaches the waiting view. */
type TabChallenge = Extract<Challenge, { kind: "device" }>

/**
 * One authorization flow, start to finish. `entry`/`starting` precede any attempt (device routes skip
 * `entry` and start on mount; `setup_token`/`api_key` routes skip straight past `starting` into `entry` and only
 * start once the user submits a secret). `waiting`/`failed` always carry the route they belong to, so a restart
 * or a retry knows what to redo without re-deriving it from `request`.
 */
type Phase =
  | { kind: "entry" }
  | { kind: "starting"; route: Route }
  | {
      kind: "waiting"
      attemptId: AttemptId
      route: Route
      challenge: TabChallenge
      expiresAt: POSIX
      tabBlocked: boolean
    }
  | { kind: "failed"; attemptId: AttemptId; route: Route; reason: FailureReason }
  | { kind: "connected"; role: "active" | "staged"; connection: ConnectionView }

/**
 * The one button-driven request in flight, or the error the last one left behind. `starting` is a device
 * start. `verifying` is a credential check (a submitted secret, or Retry on a failed test): the server bounds it
 * at 20 s, and the dialog can't be dismissed while it runs.
 */
type Submit =
  | { readonly kind: "idle" }
  | { readonly kind: "starting" }
  | { readonly kind: "verifying"; readonly provider: Provider }
  | { readonly kind: "error"; readonly error: FetchError }

const IDLE: Submit = { kind: "idle" }

const isBusy = (submit: Submit): boolean => submit.kind === "starting" || submit.kind === "verifying"

const submitErrorOf = (submit: Submit): FetchError | null => (submit.kind === "error" ? submit.error : null)

/** Where an attempt's `{status, setup}` came from. Only the start moves the dialog into `waiting`. */
type ResultOrigin =
  { readonly kind: "start"; readonly tab: Window | null } | { readonly kind: "poll" } | { readonly kind: "verify" }

/** A secret's start-then-verify round trip, or `null` when the dialog was gone before the secret was sent. */
type Verified = { readonly attemptId: AttemptId; readonly status: AuthorizationStatus; readonly setup: AiSetupView }

const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value)

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function secondsUntil(expiresAt: POSIX): number {
  return Math.max(0, Math.round(expiresAt.difference(POSIX.now()).asSeconds()))
}

/**
 * Ticks every second for the visible `mm:ss`; the countdown itself is `aria-hidden`, and the dialog's live region
 * reads a whole-minute figure instead (`useMinutesLeft`). The lazy initializer computes the first value at mount —
 * the caller keys `WaitingView` on the attempt id, so a restart (a new `expiresAt`) remounts this hook instead of
 * needing a resync inside the effect.
 */
function useSecondsLeft(expiresAt: POSIX): number {
  const [secondsLeft, setSecondsLeft] = useState(() => secondsUntil(expiresAt))
  useEffect(() => {
    const id = window.setInterval(() => setSecondsLeft(secondsUntil(expiresAt)), 1000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depends on the primitive `expiresAt.value`, not the `POSIX` object identity, so a same-valued reattempt doesn't restart the interval.
  }, [expiresAt.value])
  return secondsLeft
}

/**
 * Whole minutes left on a waiting code, rounded up. It rereads the clock every second, but its value (and so the
 * live region it feeds) changes at most once a minute. `null` when nothing is waiting.
 */
function useMinutesLeft(expiresAt: POSIX | null): number | null {
  const [now, setNow] = useState(() => POSIX.now())
  const expiresAtValue = expiresAt === null ? null : expiresAt.value
  useEffect(() => {
    if (expiresAtValue === null) return
    const id = window.setInterval(() => setNow(POSIX.now()), 1000)
    return () => window.clearInterval(id)
  }, [expiresAtValue])
  return expiresAt === null ? null : Math.ceil(Math.max(0, expiresAt.difference(now).asSeconds()) / 60)
}

const VERIFICATION_FAILURES = ["quota_exhausted", "unreachable", "invalid", "revoked", "different_account"] as const

/** A failure the adapter's `verify` call produced (the attempt was signed in first) vs. one from sign-in itself. */
function isVerificationFailure(reason: FailureReason): reason is (typeof VERIFICATION_FAILURES)[number] {
  return (VERIFICATION_FAILURES as readonly FailureReason[]).includes(reason)
}

function reasonStatusLine(reason: (typeof VERIFICATION_FAILURES)[number]): string {
  switch (reason) {
    case "quota_exhausted":
      return "This account has reached its usage limit."
    case "unreachable":
      return "The provider didn't respond in time."
    case "invalid":
      return "That value wasn't accepted."
    case "revoked":
      return "Access was revoked."
    case "different_account":
      return "Signed in with a different account than before."
    default: {
      const _exhaustiveCheck: never = reason
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/** The next-action sentence shown under every failed state (and read out by the dialog's live region). */
function reasonSentence(reason: FailureReason): string {
  switch (reason) {
    case "quota_exhausted":
      return "Wait for the limit to reset and retry, or connect a different AI. We never switch accounts or billing for you."
    case "unreachable":
      return "We couldn't reach the provider. Check your connection and retry."
    case "invalid":
      return "That wasn't accepted. Check it and enter it again."
    case "revoked":
      return "Access was revoked. Sign in again to reconnect."
    case "different_account":
      return "You signed in with a different account. To change accounts, use Switch provider in Settings."
    case "denied":
      return "Sign-in was denied. Try again to keep connecting."
    case "expired":
      return "The code expired before it was approved. Get a new one to keep going."
    case "cancelled":
      return "This attempt was cancelled."
    case "superseded":
      return "This attempt was replaced by a newer one."
    default: {
      const _exhaustiveCheck: never = reason
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

function failedTitle(provider: Provider, reason: FailureReason): { readonly title: string; readonly subtitle: string } {
  const name = PROVIDER_COPY[provider].name
  if (isVerificationFailure(reason)) {
    return { title: `${name} couldn't finish the test`, subtitle: "Signed in, but the test request failed" }
  }
  switch (reason) {
    case "denied":
      return { title: `${name} sign-in didn't finish`, subtitle: "Sign-in was denied" }
    case "expired":
      return { title: `${name} sign-in didn't finish`, subtitle: "The code expired" }
    case "cancelled":
      return { title: `${name} sign-in didn't finish`, subtitle: "Cancelled" }
    case "superseded":
      return { title: `${name} sign-in didn't finish`, subtitle: "Replaced by a newer attempt" }
    default: {
      const _exhaustiveCheck: never = reason
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/** The live region's sentence for one state. The views themselves carry no live regions of their own. */
function statusMessage(phase: Phase, submit: Submit, minutesLeft: number | null): string {
  if (submit.kind === "verifying") return `Checking with ${PROVIDER_COPY[submit.provider].name}…`
  switch (phase.kind) {
    case "entry":
      return ""
    case "starting":
      // A failed start shows its own alert; this region only speaks while the start is in flight.
      return submit.kind === "starting" ? `Connecting to ${PROVIDER_COPY[phase.route.provider].name}…` : ""
    case "waiting": {
      const lead = "Waiting for approval"
      if (minutesLeft === null || minutesLeft === 0) return lead
      return `${lead}. About ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"} left`
    }
    case "failed":
      return `${failedTitle(phase.route.provider, phase.reason).title}. ${reasonSentence(phase.reason)}`
    case "connected": {
      const name = PROVIDER_COPY[phase.connection.provider].name
      return phase.role === "active" ? `${name} is connected` : `${name} connected and tested`
    }
    default: {
      const _exhaustiveCheck: never = phase
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------------------------------------------

function Header({
  provider,
  title,
  subtitle,
  onClose,
  closeDisabled,
}: {
  readonly provider: Provider | null
  readonly title: string
  readonly subtitle: string | null
  readonly onClose: () => void
  /** True while a credential is being checked: the check isn't aborted, so the dialog waits for its answer. */
  readonly closeDisabled: boolean
}) {
  return (
    <div className="flex items-start gap-3 px-8 pt-6">
      {provider !== null ?
        <ProviderMark provider={provider} />
      : null}
      <div className="flex-1">
        <DialogTitle className="text-base leading-none font-semibold">{title}</DialogTitle>
        {subtitle !== null ?
          <DialogDescription className="mt-1 text-[13px]">{subtitle}</DialogDescription>
        : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel and close"
        disabled={closeDisabled}
        onClick={onClose}
      >
        <HugeiconsIcon icon={Cancel01Icon} />
      </Button>
    </div>
  )
}

function Footer({ children }: { readonly children: ReactNode }) {
  return <div className="flex items-center justify-between gap-2 border-t border-divider px-8 py-4">{children}</div>
}

function StatusItem({ ok, label, detail }: { readonly ok: boolean; readonly label: string; readonly detail?: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <HugeiconsIcon
        icon={ok ? Tick02Icon : Cancel01Icon}
        className={cn("mt-0.5 size-4", ok ? "text-success" : "text-danger")}
        aria-hidden="true"
      />
      <div>
        <div className="text-sm text-ink-strong">{label}</div>
        {detail !== undefined ?
          <div className="text-xs text-ink-soft">{detail}</div>
        : null}
      </div>
    </li>
  )
}

/** The visible "Checking with …" line while a credential is verified; `DialogStatus` announces the same words. */
function CheckingLine({ provider }: { readonly provider: Provider }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <HugeiconsIcon icon={Loading03Icon} className="motion-safe:animate-spin" aria-hidden="true" />
      <span>Checking with {PROVIDER_COPY[provider].name}…</span>
    </div>
  )
}

/**
 * The dialog's one live region. It stays mounted inside `DialogContent` for the dialog's whole life, so a phase
 * change rewrites its text instead of mounting a fresh region (which screen readers often skip), and nothing
 * announces a state twice.
 */
function DialogStatus({ phase, submit }: { readonly phase: Phase; readonly submit: Submit }) {
  const minutesLeft = useMinutesLeft(phase.kind === "waiting" ? phase.expiresAt : null)
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {statusMessage(phase, submit, minutesLeft)}
    </p>
  )
}

/**
 * The failed view's primary action, by reason: `retry` re-verifies the same attempt (`quota_exhausted` /
 * `unreachable` — the credential is still good, only the check failed); `restart` and `reenter` both hand off to
 * `handleRestart`, which reopens a tab for a tab route or clears back to the entry form for an entry route (an
 * entry route's secret is already cleared, so "restart" there can only mean "type it again"); `none` means the
 * attempt is simply over.
 */
function failedActionLabel(reason: FailureReason): {
  readonly kind: "retry" | "restart" | "none"
  readonly label: string
} {
  switch (reason) {
    case "quota_exhausted":
    case "unreachable":
      return { kind: "retry", label: "Retry" }
    case "expired":
      return { kind: "restart", label: "Get a new code" }
    case "denied":
    case "revoked":
    case "different_account":
      return { kind: "restart", label: "Try again" }
    case "invalid":
      return { kind: "restart", label: "Enter it again" }
    case "cancelled":
    case "superseded":
      return { kind: "none", label: "" }
    default: {
      const _exhaustiveCheck: never = reason
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Phase views
// ---------------------------------------------------------------------------------------------------------------

/** A5 (setup_token, provider fixed) / A6 (api_key, provider toggled). No attempt exists until Connect. */
function EntryView({
  request,
  provider,
  onProviderChange,
  availability,
  secret,
  onSecretChange,
  submit,
  onCancel,
  onConnect,
  lockProvider,
}: {
  readonly request: ConnectRequest
  readonly provider: Provider
  readonly onProviderChange: (provider: Provider) => void
  readonly availability: (provider: Provider) => RouteView["availability"]
  readonly secret: string
  readonly onSecretChange: (value: string) => void
  readonly submit: Submit
  readonly onCancel: () => void
  readonly onConnect: () => void
  /** Reconnect renews this provider's key; another provider is a switch, which the server would refuse here. */
  readonly lockProvider: boolean
}) {
  const isApiKey = request.kind === "apiKey"
  const copy = PROVIDER_COPY[provider]
  const title = isApiKey ? "Connect with an API key" : "Connect Claude with a setup token"
  const subtitle = isApiKey ? "Billed to the provider's API account, not your chat plan" : copy.billing
  const busy = isBusy(submit)
  const submitError = submitErrorOf(submit)
  const keyError =
    isApiKey && availability(provider) === "live" && secret.trim() !== "" ? checkApiKey(provider, secret) : Nothing()

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        onConnect()
      }}
    >
      <Header
        provider={isApiKey ? null : provider}
        title={title}
        subtitle={subtitle}
        onClose={onCancel}
        closeDisabled={submit.kind === "verifying"}
      />
      <div className="flex flex-col gap-4 px-8 py-6">
        {isApiKey ?
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <ToggleGroup
              variant="outline"
              spacing={0}
              value={[provider]}
              onValueChange={(next) => {
                const first = next[0]
                if (first !== undefined && isProvider(first)) onProviderChange(first)
              }}
              aria-label="Provider"
              className="w-full"
            >
              {PROVIDERS.map((p) => (
                <ToggleGroupItem
                  key={p}
                  value={p}
                  className="flex-1"
                  disabled={availability(p) === "unproven" || (lockProvider && p !== provider)}
                >
                  {PROVIDER_COPY[p].name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        : <div className="flex flex-col gap-2">
            <p className="text-sm leading-relaxed text-ink-body">
              In a terminal where Claude Code is installed, run this command and paste the token it prints.
            </p>
            <div className="flex items-center justify-between gap-3 border border-divider bg-canvas px-4 py-2.5">
              <span className="font-mono text-[13px] text-ink-strong">claude setup-token</span>
              <CopyButton value="claude setup-token" size="sm" className="h-7 px-2.5" />
            </div>
          </div>
        }
        <Field>
          <FieldLabel htmlFor="ai-secret">{isApiKey ? `${copy.name} API key` : "Setup token"}</FieldLabel>
          <Input
            id="ai-secret"
            type="password"
            autoComplete="off"
            placeholder={isApiKey ? copy.keyPlaceholder : "Paste token"}
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            disabled={busy}
            aria-invalid={keyError instanceof Just}
          />
          {keyError instanceof Just ?
            <FieldError>{keyError.value}</FieldError>
          : isApiKey ?
            <FieldDescription>{copy.keyHint}</FieldDescription>
          : null}
        </Field>
        {isApiKey ?
          <a
            href={copy.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
          >
            Open {copy.name} Console
            <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-end" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        : null}
        {submit.kind === "verifying" ?
          <CheckingLine provider={submit.provider} />
        : null}
        {submitError !== null ?
          <Alert variant="destructive">
            <AlertDescription>{fetchErrorToString(submitError)}</AlertDescription>
          </Alert>
        : null}
      </div>
      <Footer>
        <span />
        <div className="flex gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || secret.trim() === "" || keyError instanceof Just}>
            Connect
          </Button>
        </div>
      </Footer>
    </form>
  )
}

/** The brief span between clicking a device card and the server handing back a challenge to redirect to. */
function StartingView({
  route,
  submit,
  onRetry,
  onCancel,
}: {
  readonly route: Route
  readonly submit: Submit
  readonly onRetry: () => void
  readonly onCancel: () => void
}) {
  const busy = isBusy(submit)
  const startError = submitErrorOf(submit)
  return (
    <div className="flex flex-col">
      <Header
        provider={route.provider}
        title={`Connecting to ${PROVIDER_COPY[route.provider].name}…`}
        subtitle={null}
        onClose={onCancel}
        closeDisabled={false}
      />
      <div className="flex flex-col gap-4 px-8 py-6">
        {startError !== null ?
          <Alert variant="destructive">
            <AlertDescription>{fetchErrorToString(startError)}</AlertDescription>
          </Alert>
        : <div className="flex items-center gap-2.5 text-sm">
            <HugeiconsIcon icon={Loading03Icon} className="motion-safe:animate-spin" aria-hidden="true" />
            <span>Starting…</span>
          </div>
        }
      </div>
      <Footer>
        <span />
        <div className="flex gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          {startError !== null ?
            <Button type="button" disabled={busy} onClick={onRetry}>
              Retry
            </Button>
          : null}
        </div>
      </Footer>
    </div>
  )
}

type CopyFeedback = "idle" | "copied" | "failed"

function copyFeedbackText(feedback: CopyFeedback): string {
  switch (feedback) {
    case "idle":
      return ""
    case "copied":
      return "Copied"
    case "failed":
      return "Couldn't copy — select the code and copy it yourself."
    default: {
      const _exhaustiveCheck: never = feedback
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/** A3 (device code). */
function WaitingView({
  phase,
  onCancel,
}: {
  readonly phase: Extract<Phase, { kind: "waiting" }>
  readonly onCancel: () => void
}) {
  const { route, challenge, expiresAt, tabBlocked } = phase
  const noun = PROVIDER_COPY[route.provider].name
  const secondsLeft = useSecondsLeft(expiresAt)
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>("idle")

  const copyCode = (code: string): void => {
    // `navigator.clipboard` only exists in a secure context; a missing one fails the same way a denied write does.
    if (!("clipboard" in navigator)) {
      setCopyFeedback("failed")
      return
    }
    navigator.clipboard.writeText(code).then(
      () => setCopyFeedback("copied"),
      () => setCopyFeedback("failed")
    )
  }

  const tabUrl = challenge.verificationUrl

  return (
    <div className="flex flex-col">
      <Header
        provider={route.provider}
        title={`Finish signing in to ${noun}`}
        subtitle={tabBlocked ? `Open ${noun} to continue` : `We opened ${noun} in a new tab`}
        onClose={onCancel}
        closeDisabled={false}
      />
      <div className="flex flex-col gap-5 px-8 py-6">
        <p className="text-sm leading-relaxed text-ink-body">
          {tabBlocked ?
            `Open ${noun}, sign in, and enter this code when it asks.`
          : `Sign in on the ${noun} tab and enter this code when it asks.`}
        </p>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-stretch">
            <div className="flex-1 border border-divider-emphasis bg-inset py-3.5 text-center font-mono text-2xl tracking-[0.14em] select-all">
              {challenge.userCode}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => copyCode(challenge.userCode)}
              className="h-auto border-l-0"
            >
              <HugeiconsIcon icon={copyFeedback === "copied" ? Tick02Icon : Copy01Icon} />
              Copy
            </Button>
          </div>
          {/* Empty until the first Copy click, so its only announcements are the copy results themselves. */}
          <p
            role="status"
            className={cn("min-h-4 text-xs", copyFeedback === "failed" ? "text-destructive" : "text-ink-soft")}
          >
            {copyFeedbackText(copyFeedback)}
          </p>
        </div>
        <div className="flex items-center gap-2.5 text-sm">
          <HugeiconsIcon icon={Loading03Icon} className="motion-safe:animate-spin" aria-hidden="true" />
          <span>
            Waiting for approval
            <span aria-hidden="true">
              {" · "}
              <span className="font-mono">{formatCountdown(secondsLeft)}</span> left
            </span>
          </span>
        </div>
      </div>
      <Footer>
        <span />
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {/* No tab opened (a pop-up blocker), so opening one by hand is the step that moves the flow forward. */}
          {tabBlocked ?
            <a href={tabUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
              Open {noun}
              <HugeiconsIcon icon={LinkSquare02Icon} data-icon="inline-end" aria-hidden="true" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          : null}
        </div>
      </Footer>
    </div>
  )
}

/** A8 (verification failures) / S1 (quota) / a pre-verification failure (denied, expired, cancelled, superseded). */
function FailedView({
  phase,
  submit,
  onRetryVerify,
  onRestart,
  onClose,
}: {
  readonly phase: Extract<Phase, { kind: "failed" }>
  readonly submit: Submit
  readonly onRetryVerify: () => void
  readonly onRestart: () => void
  readonly onClose: () => void
}) {
  const { route, reason } = phase
  const { title, subtitle } = failedTitle(route.provider, reason)
  const action = failedActionLabel(reason)
  const busy = isBusy(submit)
  const verifying = submit.kind === "verifying"
  const submitError = submitErrorOf(submit)

  return (
    <div className="flex flex-col">
      <Header provider={route.provider} title={title} subtitle={subtitle} onClose={onClose} closeDisabled={verifying} />
      <div className="flex flex-col gap-4 px-8 py-6">
        {isVerificationFailure(reason) ?
          <ul className="flex flex-col gap-2.5">
            <StatusItem ok label="Signed in" />
            <StatusItem ok={false} label="Test request failed" detail={reasonStatusLine(reason)} />
          </ul>
        : null}
        {/* `DialogStatus` already reads this sentence out, so this alert drops its own `role="alert"`. */}
        <Alert variant="destructive" role={undefined}>
          <AlertDescription>{reasonSentence(reason)}</AlertDescription>
        </Alert>
        {verifying ?
          <CheckingLine provider={route.provider} />
        : null}
        {submitError !== null ?
          <Alert variant="destructive">
            <AlertDescription>{fetchErrorToString(submitError)}</AlertDescription>
          </Alert>
        : null}
      </div>
      <Footer>
        <Button type="button" variant="ghost" disabled={verifying} onClick={onClose}>
          Use a different AI
        </Button>
        {action.kind === "none" ?
          <span />
        : <Button type="button" onClick={action.kind === "retry" ? onRetryVerify : onRestart} disabled={busy}>
            {action.kind === "retry" ?
              <HugeiconsIcon icon={RefreshIcon} />
            : null}
            {action.label}
          </Button>
        }
      </Footer>
    </div>
  )
}

/** Whether the saved model is the one the provider recommends (a reconnect keeps a user's own choice). */
function isRecommended(connection: ConnectionView): boolean {
  return connection.models.some((m) => m.id === connection.preferences.model && m.recommended)
}

/** A7 — role `"active"` only; a `"staged"` connected phase renders `SwitchConfirm` instead. */
function ConnectedView({
  connection,
  onContinue,
  onClose,
}: {
  readonly connection: ConnectionView
  // `exactOptionalPropertyTypes`: accept the prop key always present so `ConnectDialog` can forward its own
  // optional `onContinue` (possibly `undefined`) without a conditional spread at the call site.
  readonly onContinue: (() => void) | undefined
  readonly onClose: () => void
}) {
  const name = PROVIDER_COPY[connection.provider].name
  return (
    <div className="flex flex-col">
      <Header
        provider={connection.provider}
        title={`${name} is connected`}
        subtitle="Checked just now"
        onClose={onClose}
        closeDisabled={false}
      />
      <div className="flex flex-col gap-5 px-8 py-6">
        <ul className="flex flex-col gap-2.5">
          <StatusItem ok label="Signed in" />
          <StatusItem ok label="Test request worked" detail="Job Kit made a test request through your account" />
          {onContinue !== undefined ?
            <StatusItem ok label="Ready for profile creation" />
          : null}
        </ul>
        <div className="h-px bg-divider" />
        <dl className="grid grid-cols-[128px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-ink-muted">Account</dt>
          <dd className="font-mono">{connection.account}</dd>
          <dt className="text-ink-muted">Billed to</dt>
          <dd>{connection.billing}</dd>
          <dt className="text-ink-muted">Model</dt>
          <dd>
            <div>
              {isRecommended(connection) ? "Recommended · " : null}
              <span className="font-mono">{connection.preferences.model}</span>
            </div>
            {/* Only onboarding needs the pointer; from Settings the model field is right there. */}
            {onContinue !== undefined ?
              <div className="text-xs text-ink-muted">Change it anytime in Settings → AI.</div>
            : null}
          </dd>
        </dl>
      </div>
      <Footer>
        <Button type="button" variant="ghost" onClick={onClose}>
          Use a different AI
        </Button>
        {onContinue !== undefined ?
          <Button type="button" onClick={onContinue}>
            Create my profile
            <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
          </Button>
        : <Button type="button" onClick={onClose}>
            Done
          </Button>
        }
      </Footer>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// ConnectDialog
// ---------------------------------------------------------------------------------------------------------------

/**
 * The shared route dialog (A3–A8, plus S5 when a switch lands). Mounting it means open — callers render it
 * conditionally rather than passing an `open` flag, so every phase transition below runs from a single mount to
 * a single unmount of one flow.
 *
 * Every way out cancels what it leaves behind: a close (X, Cancel, Escape, backdrop, "Use a different AI"), a
 * restart and a real unmount each cancel the attempt the dialog still owns, and a close from a staged switch
 * discards it. The one exception is a credential check in flight, which the dialog neither aborts nor lets anyone
 * dismiss until the server answers.
 */
function ConnectDialog(props: {
  readonly request: ConnectRequest
  readonly purpose: Purpose
  readonly tab: Window | null
  readonly current: ConnectionView | null
  readonly onSetup: (setup: AiSetupView) => void
  readonly onClose: () => void
  readonly onContinue?: () => void
}) {
  const { request, purpose, tab, current, onSetup, onClose, onContinue } = props
  const { state: setupState } = useAiSetup()

  const [phase, setPhase] = useState<Phase>(() =>
    request.kind === "route" && opensTab(request.route.method) ?
      { kind: "starting", route: request.route }
    : { kind: "entry" }
  )
  const [submit, setSubmit] = useState<Submit>(IDLE)
  const [secret, setSecret] = useState("")
  const [apiKeyProvider, setApiKeyProvider] = useState<Provider>(
    request.kind === "apiKey" ? request.provider : PROVIDERS[0]
  )
  // The switch that was already staged before this dialog opened. Any other staged connection a cancel reports
  // back was left by this dialog's own attempt, so the cancel discards it too (see `cancelAttempt`).
  const [stagedAtMount] = useState<string | null>(() =>
    setupState instanceof Ready && setupState.value.staged !== null ? setupState.value.staged.connectionId.value : null
  )

  // The attempt this dialog owns and hasn't seen connect: what a close, a restart or a real unmount cancels.
  const attemptIdRef = useRef<AttemptId | null>(null)
  const pollCancelRef = useRef<Cancel>(() => {})
  // One poll at a time: the 3 s interval and the window `focus` handler share this flag.
  const pollInFlightRef = useRef(false)
  const pollIntervalRef = useRef<number | null>(null)
  const focusCleanupRef = useRef<() => void>(() => {})
  // One start per dialog instance. StrictMode mounts, cleans up and remounts in dev; a second start would supersede
  // the first, and whichever response landed last would win. Refs survive that remount, so this guard holds.
  const startedRef = useRef(false)
  // False only after a real unmount (StrictMode's simulated one flips it back on remount).
  const mountedRef = useRef(false)
  // Set once, by a close or a real unmount. From then on every attempt response is dropped (it would overwrite the
  // setup the close's own cancel returns), and neither path cancels a second time.
  const closedRef = useRef(false)

  const verifying = submit.kind === "verifying"
  const entryProvider: Provider = request.kind === "apiKey" ? apiKeyProvider : request.route.provider
  const entryMethod: Method = request.kind === "apiKey" ? "api_key" : request.route.method

  const availability = (provider: Provider): RouteView["availability"] =>
    setupState instanceof Ready ? routeAvailability(setupState.value, { provider, method: "api_key" }) : "unproven"

  const isGone = (): boolean => closedRef.current || !mountedRef.current

  const stopPolling = (): void => {
    if (pollIntervalRef.current !== null) {
      window.clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    pollCancelRef.current()
    pollCancelRef.current = () => {}
    pollInFlightRef.current = false
    focusCleanupRef.current()
    focusCleanupRef.current = () => {}
  }

  /**
   * Fire-and-forget cancel of an attempt the dialog is abandoning; the server closes it only while it's still
   * open. For a switch, an attempt that verified after the dialog stopped listening leaves a staged connection
   * behind, so one that wasn't staged when the dialog opened is discarded before the setup is handed on.
   */
  const cancelAttempt = (attemptId: AttemptId): void => {
    call(api.cancelAiAuthorization, { attemptId }).fork(
      () => {}, // best effort: an attempt nobody cancels still expires on its own
      ({ setup }) => {
        const staged = setup.staged
        if (purpose !== "switch" || staged === null || staged.connectionId.value === stagedAtMount) {
          onSetup(setup)
          return
        }
        call(api.discardAiSwitch, { connectionId: staged.connectionId }).fork(
          () => onSetup(setup),
          (discarded) => onSetup(discarded.setup)
        )
      }
    )
  }

  const redirectTab = (openedTab: Window | null, challenge: TabChallenge): void => {
    if (openedTab === null) return
    openedTab.opener = null
    openedTab.location.href = challenge.verificationUrl
  }

  /** Applies one `{status, setup}` response — dropping it if the dialog is gone or a newer attempt superseded it. */
  const handleResult = (
    attemptId: AttemptId,
    route: Route,
    status: AuthorizationStatus,
    setup: AiSetupView,
    origin: ResultOrigin
  ): void => {
    if (isGone()) return
    onSetup(setup)
    const currentAttemptId = attemptIdRef.current
    if (currentAttemptId === null || currentAttemptId.value !== attemptId.value) return
    switch (status.status) {
      case "pending": {
        // Only the start moves the dialog into `waiting`, and only the start knows whether the tab opened. A poll
        // that finds the attempt still pending changes nothing: re-entering `waiting` from it would reset
        // `tabBlocked` (polls carry no tab) and restart the polling.
        if (origin.kind !== "start") return
        const { challenge } = status
        if (challenge.kind === "entry") return // never produced for a route this dialog started
        redirectTab(origin.tab, challenge)
        setPhase({
          kind: "waiting",
          attemptId,
          route,
          challenge,
          expiresAt: status.expiresAt,
          tabBlocked: origin.tab === null,
        })
        startPolling(attemptId, route)
        return
      }
      case "failed":
        stopPolling()
        // A start that fails (an overlapping start superseded it) never sends its pre-opened tab anywhere.
        if (origin.kind === "start") origin.tab?.close()
        setPhase({ kind: "failed", attemptId, route, reason: status.reason })
        return
      case "connected": {
        stopPolling()
        attemptIdRef.current = null // connected: nothing left to cancel, and a straggling poll for it is dropped
        const connection = status.role === "active" ? setup.active : setup.staged
        if (connection === null) return // server invariant: a "connected" status always carries that role's connection
        setPhase({ kind: "connected", role: status.role, connection })
        return
      }
      default: {
        const _exhaustiveCheck: never = status
        throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
      }
    }
  }

  const startPolling = (attemptId: AttemptId, route: Route): void => {
    stopPolling()
    const poll = (): void => {
      if (pollInFlightRef.current) return // the previous poll hasn't answered yet; the next tick tries again
      pollInFlightRef.current = true
      pollCancelRef.current = call(api.advanceAiAuthorization, { attemptId, step: { kind: "poll" } }).fork(
        () => {
          pollInFlightRef.current = false // a transient poll failure isn't shown; the next tick or focus recovers it
        },
        ({ status, setup }) => {
          pollInFlightRef.current = false
          handleResult(attemptId, route, status, setup, { kind: "poll" })
        }
      )
    }
    pollIntervalRef.current = window.setInterval(poll, 3000)
    const onFocus = (): void => poll()
    window.addEventListener("focus", onFocus)
    focusCleanupRef.current = () => window.removeEventListener("focus", onFocus)
  }

  const beginTabRoute = (route: Route, openedTab: Window | null): void => {
    stopPolling()
    setSubmit({ kind: "starting" })
    setPhase({ kind: "starting", route })
    // Never aborted: a start the dialog walked away from still has to land, so it can cancel its own attempt.
    call(api.startAiAuthorization, {
      provider: route.provider,
      method: route.method,
      purpose,
    }).fork(
      (error) => {
        openedTab?.close() // nothing will ever be sent to it; a retry opens a fresh one
        if (isGone()) return
        setSubmit({ kind: "error", error })
      },
      ({ attemptId, status, setup }) => {
        if (isGone()) {
          // The dialog closed before the provider answered: drop the attempt rather than send the user to it.
          openedTab?.close()
          cancelAttempt(attemptId)
          return
        }
        setSubmit(IDLE)
        attemptIdRef.current = attemptId
        handleResult(attemptId, route, status, setup, { kind: "start", tab: openedTab })
      }
    )
  }

  const submitSecret = (): void => {
    if (isBusy(submit) || secret.trim() === "") return
    const route: Route = { provider: entryProvider, method: entryMethod }
    const value = secret
    setSecret("") // cleared on submit — held only in component state, never storage
    setSubmit({ kind: "verifying", provider: route.provider })
    call(api.startAiAuthorization, {
      provider: route.provider,
      method: route.method,
      purpose,
    })
      .chain(({ attemptId, setup }): Future<FetchError, Verified | null> => {
        if (isGone()) {
          // Unmounted before the attempt existed: drop it rather than hand it the secret.
          cancelAttempt(attemptId)
          return Future.resolve<FetchError, Verified | null>(null)
        }
        onSetup(setup)
        attemptIdRef.current = attemptId
        return call(api.advanceAiAuthorization, { attemptId, step: { kind: "secret", secret: value } }).map(
          (result): Verified | null => ({ attemptId, ...result })
        )
      })
      .fork(
        (error) => {
          if (isGone()) return
          setSubmit({ kind: "error", error })
        },
        (verified) => {
          if (verified === null || isGone()) return
          setSubmit(IDLE)
          handleResult(verified.attemptId, route, verified.status, verified.setup, { kind: "verify" })
        }
      )
  }

  const retryVerify = (attemptId: AttemptId, route: Route): void => {
    if (isBusy(submit)) return
    setSubmit({ kind: "verifying", provider: route.provider })
    call(api.advanceAiAuthorization, { attemptId, step: { kind: "retry" } }).fork(
      (error) => {
        if (isGone()) return
        setSubmit({ kind: "error", error })
      },
      ({ status, setup }) => {
        if (isGone()) return
        setSubmit(IDLE)
        handleResult(attemptId, route, status, setup, { kind: "verify" })
      }
    )
  }

  const handleRestart = (route: Route): void => {
    // First and synchronous: this runs straight from the button's own click handler, so the tab isn't blocked.
    const freshTab = opensTab(route.method) ? openProviderTab() : null
    const previous = attemptIdRef.current
    attemptIdRef.current = null
    if (previous !== null) cancelAttempt(previous)
    if (opensTab(route.method)) {
      beginTabRoute(route, freshTab)
    } else {
      setSecret("")
      setSubmit(IDLE)
      setPhase({ kind: "entry" })
    }
  }

  const handleClose = (): void => {
    // A credential check is never aborted, so the dialog stays until it answers (the controls say so too).
    if (closedRef.current || verifying) return
    closedRef.current = true
    stopPolling()
    setSecret("") // cleared on cancel — held only in component state, never storage
    if (phase.kind === "connected") {
      if (phase.role === "active") {
        onClose()
        return
      }
      call(api.discardAiSwitch, { connectionId: phase.connection.connectionId }).fork(
        () => onClose(),
        ({ setup }) => {
          onSetup(setup)
          onClose()
        }
      )
      return
    }
    // Any other phase may own a live attempt (waiting, failed, or an entry form whose verify failed to send).
    const attemptId = attemptIdRef.current
    attemptIdRef.current = null
    if (attemptId !== null) cancelAttempt(attemptId)
    onClose()
  }

  /** Runs after the effect cleanup settles: a StrictMode remount has set `mountedRef` again by then, a real unmount hasn't. */
  const abandonIfUnmounted = (): void => {
    if (mountedRef.current || closedRef.current) return
    closedRef.current = true
    const attemptId = attemptIdRef.current
    attemptIdRef.current = null
    if (attemptId !== null) cancelAttempt(attemptId)
  }

  useEffect(() => {
    mountedRef.current = true
    // Mounting this dialog for a device route IS starting that attempt; `beginTabRoute` sets `submit`/`phase`
    // synchronously so the dialog shows "Connecting…" at once instead of a blank frame.
    if (!startedRef.current && request.kind === "route" && opensTab(request.route.method)) {
      startedRef.current = true
      beginTabRoute(request.route, tab)
    }
    return () => {
      mountedRef.current = false
      // The start is not cancelled here: StrictMode's simulated unmount would abort it with nothing left to resend.
      // A start that lands after a real unmount cancels its own attempt (see `beginTabRoute`).
      stopPolling()
      setSecret("") // cleared on unmount — held only in component state, never storage
      // StrictMode runs this cleanup and the effect again back to back, so the check waits a microtask.
      queueMicrotask(abandonIfUnmounted)
    }
    // Deliberately empty: `request`/`tab`/`purpose` are fixed for this dialog's mounted lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const content = (() => {
    switch (phase.kind) {
      case "entry":
        return (
          <EntryView
            request={request}
            provider={entryProvider}
            onProviderChange={setApiKeyProvider}
            availability={availability}
            secret={secret}
            onSecretChange={setSecret}
            submit={submit}
            onCancel={handleClose}
            onConnect={submitSecret}
            lockProvider={purpose === "reconnect"}
          />
        )
      case "starting":
        return (
          <StartingView
            route={phase.route}
            submit={submit}
            onRetry={() => beginTabRoute(phase.route, openProviderTab())}
            onCancel={handleClose}
          />
        )
      case "waiting":
        // Keyed on the attempt: a restart from `failed` produces a new `expiresAt` for the same phase kind, and
        // remounting (rather than re-rendering in place) keeps `useSecondsLeft`'s countdown correct without a
        // second, effect-driven resync.
        return <WaitingView key={phase.attemptId.value} phase={phase} onCancel={handleClose} />
      case "failed":
        return (
          <FailedView
            phase={phase}
            submit={submit}
            onRetryVerify={() => retryVerify(phase.attemptId, phase.route)}
            onRestart={() => handleRestart(phase.route)}
            onClose={handleClose}
          />
        )
      case "connected":
        return phase.role === "active" ?
            <ConnectedView connection={phase.connection} onContinue={onContinue} onClose={handleClose} />
          : <SwitchConfirm current={current} staged={phase.connection} onSetup={onSetup} onDone={onClose} />
      default: {
        const _exhaustiveCheck: never = phase
        throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
      }
    }
  })()

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape and the backdrop are ignored while a credential check runs, like the X and Cancel buttons.
        if (!open && !verifying) handleClose()
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-4rem)] gap-0 p-0 sm:max-w-[480px]">
        <ScrollArea viewportProps={{ className: "h-auto max-h-[calc(100dvh-4rem)]" }}>{content}</ScrollArea>
        <DialogStatus phase={phase} submit={submit} />
      </DialogContent>
    </Dialog>
  )
}
