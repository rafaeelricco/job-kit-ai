export default SetupPage

import { type ReactNode, useEffect, useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { ArrowRight01Icon, ArrowRight02Icon, Cancel01Icon, LockIcon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import * as s from "@lib/json/schema"
import { api } from "@api/endpoints"
import { call, fetchErrorToString, type FetchError } from "@api/request"
import { Future } from "@lib/future"
import { Failed, Loading, NotAsked, Ready, type RemoteData } from "@lib/remote-data"
import { POSIX } from "@lib/time"
import { cn } from "@components/utils"
import { signOut } from "@module/session/session"
import { Alert, AlertDescription } from "@ui/alert"
import { Badge } from "@ui/badge"
import { Button, buttonVariants } from "@ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@ui/dialog"
import { ScrollArea } from "@ui/scroll-area"

import { LoadingRows } from "@module/access/access-gate"
import { ConnectDialog, type ConnectRequest } from "@module/ai/components/connect-dialog"
import { ProviderGrid } from "@module/ai/components/provider-grid"
import { ProviderMark } from "@module/ai/components/provider-mark"
import { SwitchConfirmDialog } from "@module/ai/components/switch-confirm"
import { PROVIDER_COPY, PROVIDERS, openProviderTab, opensTab, routeAvailability } from "@module/ai/providers"
import {
  type AiSetupView,
  type ConnectionStatus,
  type ConnectionView,
  type Method,
  type Provider,
  type Purpose,
} from "@module/ai/types"
import { useAiSetup } from "@module/ai/use-ai-setup"

type StepId = "overview" | "connect"

type CompleteSetupStepResponse = s.Infer<typeof api.completeSetupStep.response>

/**
 * A thin wrapper around `call(api.completeSetupStep, ...)`. Passing the literal object inline at the call site
 * makes TypeScript widen the discriminated `step` field to `string` while inferring `call`'s generic parameters
 * (it appears in both a covariant and a contravariant position across the two arguments) — routing it through a
 * parameter typed `StepId` keeps the literal union intact.
 */

/** The route as a noun phrase: "chose OpenAI device login". */
const ROUTE_PHRASE: Record<Method, string> = {
  device: "device login",
  setup_token: "setup token",
  api_key: "API key",
}

function completeSetupStep(step: StepId): Future<FetchError, CompleteSetupStepResponse> {
  return call(api.completeSetupStep, { step })
}

// ---------------------------------------------------------------------------------------------------------------
// Header: brand + progress stepper + the one contextual action (artboard A1/A2/A9's shared chrome)
// ---------------------------------------------------------------------------------------------------------------

/** The mascot mark + wordmark markup, duplicated from `app-sidebar.tsx:80-93` — that file exports only the whole sidebar. */
function Brand() {
  return (
    <div className="flex items-center gap-2">
      <img
        src={`${import.meta.env.BASE_URL}brand/mascot-mark.svg`}
        alt=""
        className="size-7 shrink-0 object-contain dark:hidden"
      />
      <img
        src={`${import.meta.env.BASE_URL}brand/mascot-mark-dark.svg`}
        alt=""
        className="hidden size-7 shrink-0 object-contain dark:block"
      />
      <span className="truncate font-logo text-sm font-bold tracking-wide uppercase">Job Kit AI</span>
    </div>
  )
}

function Stepper({
  current,
  overviewDone,
  connectDone,
}: {
  readonly current: StepId
  readonly overviewDone: boolean
  readonly connectDone: boolean
}) {
  const steps: {
    readonly id: StepId | "profile"
    readonly index: number
    readonly label: string
    readonly done: boolean
  }[] = [
    { id: "overview", index: 1, label: "Overview", done: overviewDone },
    { id: "connect", index: 2, label: "Connect AI", done: connectDone },
    // Step 03 doesn't exist yet, so this step is never current and never done — a fixed placeholder in the rail.
    { id: "profile", index: 3, label: "Create profile", done: false },
  ]
  return (
    <ol aria-label="Setup progress" className="flex items-center gap-3">
      {steps.flatMap((step, index) => [
        index > 0 ?
          <li key={`sep-${step.id}`} aria-hidden="true" className="h-px w-6 shrink-0 bg-divider-emphasis sm:w-10" />
        : null,
        <li
          key={step.id}
          aria-current={step.id === current ? "step" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2 text-sm whitespace-nowrap",
            step.id === current ? "font-medium text-ink-strong" : "text-ink-soft"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex size-5 shrink-0 items-center justify-center font-mono text-[11px]",
              step.id === current ? "border-[1.5px] border-ink-strong text-ink-strong"
              : step.done ? "bg-primary text-primary-foreground"
              : "border border-divider-emphasis text-ink-soft"
            )}
          >
            {step.id !== current && step.done ?
              <HugeiconsIcon icon={Tick02Icon} className="size-3" aria-hidden="true" />
            : step.index}
          </span>
          {/* Below `sm` only the squares show; the label and its state stay in the list for screen readers. */}
          <span className="sr-only sm:not-sr-only">{step.label}</span>
          {step.done ?
            <span className="sr-only"> (done)</span>
          : null}
        </li>,
      ])}
    </ol>
  )
}

function WizardHeader({
  current,
  overviewDone,
  connectDone,
  action,
}: {
  readonly current: StepId
  readonly overviewDone: boolean
  readonly connectDone: boolean
  readonly action: { readonly label: string; readonly onClick: () => void }
}) {
  return (
    // One row only from `lg`: below that the labelled stepper doesn't fit between brand and action, so it takes a
    // row of its own instead of scrolling sideways.
    <header className="flex flex-col gap-3 border-b border-divider px-4 py-3 sm:px-8 lg:h-16 lg:flex-row lg:items-center lg:justify-between lg:gap-0 lg:py-0">
      <div className="flex items-center justify-between gap-2 lg:min-w-40 lg:justify-start">
        <Brand />
        <Button type="button" variant="ghost" className="lg:hidden" onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
      <div className="flex justify-center">
        <Stepper current={current} overviewDone={overviewDone} connectDone={connectDone} />
      </div>
      <div className="hidden justify-end lg:flex lg:min-w-40">
        <Button type="button" variant="ghost" onClick={action.onClick}>
          {action.label}
        </Button>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// SetupPage: the RemoteData cell (pages.md) — no app chrome, so its own status surfaces replace AccessGate's.
// ---------------------------------------------------------------------------------------------------------------

function SetupPage() {
  const { state } = useAiSetup()
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      {state instanceof Ready ?
        <Wizard setup={state.value} />
      : state instanceof Loading || state instanceof NotAsked ?
        <PageLoading />
      : state instanceof Failed ?
        <div className="flex flex-1 items-center justify-center p-6">
          <Alert variant="destructive" className="max-w-md">
            <AlertDescription>{fetchErrorToString(state.error)}</AlertDescription>
          </Alert>
        </div>
      : (state satisfies never)}
    </div>
  )
}

function PageLoading() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md">
        <LoadingRows />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Wizard: the state machine over one Ready AiSetupView (Overview -> Resume -> Connect(+dialog))
// ---------------------------------------------------------------------------------------------------------------

type WizardDialog = { readonly request: ConnectRequest; readonly purpose: Purpose; readonly tab: Window | null }

function Wizard({ setup }: { readonly setup: AiSetupView }) {
  const { replace } = useAiSetup()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  // A9 shows once per page load at most: opening any dialog, or picking "Choose another route", dismisses it for
  // the rest of this mount even if the same conditions still hold afterward (e.g. after cancelling that dialog).
  const [resumeDismissed, setResumeDismissed] = useState(false)
  // The load-time A7 dialog, dismissed by closing it or any connect dialog (so closing the live A7 never reopens
  // it). From then on the compact "Connected" bar above the grid carries the same "Create my profile".
  const [connectedDismissed, setConnectedDismissed] = useState(false)
  const [dialog, setDialog] = useState<WizardDialog | null>(null)

  // A resumed wizard (an earlier visit connected but never finished setup) re-tests that connection once before
  // offering it as ready: the stored status can be stale by now. The first setup this mount saw decides it.
  const [recheckId] = useState(() =>
    setup.active !== null && !setup.setupCompleted ? setup.active.connectionId : null
  )
  const [recheck, setRecheck] = useState<RemoteData<FetchError, void>>(() =>
    recheckId === null ? NotAsked() : Loading()
  )
  useEffect(() => {
    if (recheckId === null) return
    return call(api.testAiConnection, { connectionId: recheckId }).fork(
      // The stored view stands: a connection that really is broken still shows as needing attention.
      (error) => setRecheck(Failed(error)),
      ({ setup: rechecked }) => {
        replace(rechecked)
        setRecheck(Ready(undefined))
      }
    )
  }, [recheckId, replace])

  const showOverview = params.get("step") === "overview" || !setup.overviewCompleted

  // Setup is already done and nothing asked for the overview explicitly: SetupGate no longer sends anyone here,
  // so the only way in is a stale link. Bounce home rather than showing a Connect step this account already passed.
  if (setup.setupCompleted && !showOverview) return <Navigate to="/" replace />

  // A card picked while a connection exists is a switch, so choosing another route never replaces it on its own.
  const choosePurpose: Purpose = setup.active !== null ? "switch" : "initial"

  const openDialog = (request: ConnectRequest, tab: Window | null, purpose: Purpose): void => {
    setResumeDismissed(true)
    setDialog({ request, purpose, tab })
  }

  const closeDialog = (): void => {
    setDialog(null)
    setConnectedDismissed(true)
  }

  const reconnect = (connection: ConnectionView): void => {
    // Synchronous with the click, so a device tab isn't blocked as script-timed.
    const tab = opensTab(connection.method) ? openProviderTab() : null
    const request: ConnectRequest =
      connection.method === "api_key" ?
        { kind: "apiKey", provider: connection.provider }
      : { kind: "route", route: { provider: connection.provider, method: connection.method } }
    openDialog(request, tab, "reconnect")
  }

  const completeOverview = (): void => {
    setResumeDismissed(true)
    completeSetupStep("overview").fork(
      (error) => toast.error(fetchErrorToString(error)),
      (response) => {
        replace(response.setup)
        if (params.has("step")) {
          const next = new URLSearchParams(params)
          next.delete("step")
          setParams(next, { replace: true })
        }
      }
    )
  }

  const completeConnectAndGoHome = (): void => {
    completeSetupStep("connect").fork(
      (error) => toast.error(fetchErrorToString(error)),
      (response) => {
        replace(response.setup)
        navigate("/", { replace: true })
      }
    )
  }

  // No route can connect (production, until a real adapter passes its checks): nothing on this step can finish,
  // so the way out goes back to the app instead of signing out.
  const noRoute = setup.routes.every((route) => route.availability === "unproven")

  const headerAction =
    showOverview ?
      setup.setupCompleted ?
        { label: "Back to Job Kit", onClick: () => navigate("/") }
      : { label: "Skip to Connect AI", onClick: completeOverview }
    : noRoute ? { label: "Back to Job Kit", onClick: () => navigate("/") }
    : { label: "Save and exit", onClick: signOut }

  if (showOverview) {
    return (
      <>
        <WizardHeader
          current="overview"
          overviewDone={setup.overviewCompleted}
          connectDone={setup.setupCompleted}
          action={headerAction}
        />
        <OverviewContent
          primaryLabel={setup.setupCompleted ? "Back to Job Kit" : "Connect my AI"}
          onPrimary={setup.setupCompleted ? () => navigate("/") : completeOverview}
        />
      </>
    )
  }

  if (recheck instanceof Loading) return <PageLoading />

  const { active, staged } = setup
  const ready = active !== null && active.status === "ready" ? active : null
  const attention = active !== null && active.status !== "ready" ? active : null

  const canResume = setup.overviewCompleted && active === null && setup.lastAuthorization !== null
  const showResume = canResume && !resumeDismissed && dialog === null

  // A staged switch (a refresh mid-switch) is settled first: keep the current AI, or switch to the new one.
  const showSwitch = dialog === null && staged !== null
  const showConnected =
    !showResume && !showSwitch && dialog === null && ready !== null && !setup.setupCompleted && !connectedDismissed
  const showConnectedBar = !showConnected && !showSwitch && dialog === null && ready !== null && !setup.setupCompleted

  const notice: ReactNode =
    noRoute ? <NoRouteNotice />
    : attention !== null ? <AttentionNotice connection={attention} onReconnect={() => reconnect(attention)} />
    : showConnectedBar && ready !== null ? <ConnectedBar connection={ready} onContinue={completeConnectAndGoHome} />
    : null

  return (
    <>
      <WizardHeader
        current="connect"
        overviewDone={setup.overviewCompleted}
        connectDone={setup.setupCompleted}
        action={headerAction}
      />
      {showResume && setup.lastAuthorization !== null ?
        <ResumeContent
          lastAuthorization={setup.lastAuthorization}
          onResume={(request, tab) => openDialog(request, tab, choosePurpose)}
          onChooseAnother={() => setResumeDismissed(true)}
        />
      : <ConnectContent
          setup={setup}
          notice={notice}
          onChoose={(route, tab) => openDialog({ kind: "route", route }, tab, choosePurpose)}
          onApiKey={(request, tab) => openDialog(request, tab, choosePurpose)}
        />
      }
      {dialog !== null ?
        <ConnectDialog
          request={dialog.request}
          purpose={dialog.purpose}
          tab={dialog.tab}
          current={setup.active}
          onSetup={replace}
          onClose={closeDialog}
          onContinue={completeConnectAndGoHome}
        />
      : null}
      {/* Its own buttons settle it ("Keep …" discards, "Switch to …" confirms); the new setup then unmounts it. */}
      {showSwitch && staged !== null ?
        <SwitchConfirmDialog
          open
          onOpenChange={() => {}}
          current={setup.active}
          staged={staged}
          onSetup={replace}
          onDone={() => {}}
        />
      : null}
      {showConnected && ready !== null ?
        <ConnectedDialog
          connection={ready}
          onContinue={completeConnectAndGoHome}
          onClose={() => setConnectedDismissed(true)}
        />
      : null}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Overview (A1)
// ---------------------------------------------------------------------------------------------------------------

function OverviewContent({
  primaryLabel,
  onPrimary,
}: {
  readonly primaryLabel: string
  readonly onPrimary: () => void
}) {
  return (
    <main className="flex flex-1 flex-col gap-8 px-4 py-10 sm:px-12 sm:py-12">
      <div className="flex max-w-2xl flex-col gap-3">
        <h1 className="text-3xl leading-tight font-medium tracking-tight text-ink-strong sm:text-4xl">
          Job Kit finds openings that fit you and shows why they match.
        </h1>
        <p className="text-base leading-relaxed text-ink-body">
          It uses your own AI account. AI proposes your profile from your CV; you confirm every fact before anything is
          used.
        </p>
      </div>

      <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-stretch">
        <SampleCard step={1} label="Your profile and preferences">
          <div className="flex flex-col gap-3 border border-divider bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium tracking-[0.6px] text-ink-soft uppercase">Profile</span>
              <Badge variant="secondary">SAMPLE</Badge>
            </div>
            <div>
              <div className="text-[15px] font-semibold text-ink-strong">Sample candidate</div>
              <div className="text-[13px] text-ink-soft">Senior frontend engineer · Remote, EU hours</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["react", "typescript", "design-systems", "8y"].map((tag) => (
                <code key={tag}>{tag}</code>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-soft">
              <HugeiconsIcon icon={Tick02Icon} className="size-3.5" aria-hidden="true" />
              11 facts confirmed by you
            </div>
          </div>
        </SampleCard>

        <Arrow />

        <SampleCard step={2} label="Relevant openings, with reasons">
          <div className="flex flex-col gap-2 border border-divider bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium tracking-[0.6px] text-ink-soft uppercase">Matches</span>
              <Badge variant="secondary">SAMPLE</Badge>
            </div>
            <div>
              {[
                { role: "Staff Frontend Engineer", id: "sample-co-a", score: 86 },
                { role: "Senior UI Engineer", id: "sample-co-b", score: 78 },
                { role: "Frontend Platform Lead", id: "sample-co-c", score: 71 },
              ].map((row) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between border-t border-divider py-2 first:border-t-0"
                >
                  <div>
                    <div className="text-[13px] font-medium text-ink-strong">{row.role}</div>
                    <div className="font-mono text-[11px] text-ink-soft">{row.id}</div>
                  </div>
                  <span className="font-mono text-[13px] text-ink-strong">
                    {row.score}
                    <span className="text-ink-soft">/100</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </SampleCard>

        <Arrow />

        <SampleCard step={3} label="Open a posting from its dossier">
          <div className="flex flex-col gap-3 border border-divider bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium tracking-[0.6px] text-ink-soft uppercase">Dossier</span>
              <Badge variant="secondary">SAMPLE</Badge>
            </div>
            <div className="text-[15px] font-semibold text-ink-strong">Staff Frontend Engineer</div>
            <div className="flex gap-1.5">
              <code>greenhouse</code>
              <code>2026-09-18</code>
            </div>
            <ul className="flex flex-col gap-1 text-[13px] text-ink-body">
              <li>Asks for design-system ownership — matches your confirmed work</li>
              <li>Remote within EU — matches your preference</li>
            </ul>
            <span aria-hidden="true" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}>
              Open posting
              <HugeiconsIcon icon={ArrowRight02Icon} data-icon="inline-end" aria-hidden="true" />
            </span>
          </div>
        </SampleCard>
      </div>

      <div className="flex flex-col items-start gap-4 border-t border-divider pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-[13px] text-ink-soft">
          For now you can review matches and open postings. Help with applications comes in a later release. You can
          reopen this overview from Settings.
        </p>
        <Button type="button" size="lg" onClick={onPrimary}>
          {primaryLabel}
          <HugeiconsIcon icon={ArrowRight02Icon} data-icon="inline-end" />
        </Button>
      </div>
    </main>
  )
}

function SampleCard({
  step,
  label,
  children,
}: {
  readonly step: number
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col gap-2.5">
      <div className="text-sm font-medium text-ink-strong">
        {step}. {label}
      </div>
      {children}
    </div>
  )
}

/** Purely decorative — the numbered captions above each card already say the same order in text. */
function Arrow() {
  return (
    <div aria-hidden="true" className="hidden shrink-0 items-center text-ink-faint sm:flex">
      <HugeiconsIcon icon={ArrowRight02Icon} className="size-5" />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Connect (A2)
// ---------------------------------------------------------------------------------------------------------------

function ConnectContent({
  setup,
  notice,
  onChoose,
  onApiKey,
}: {
  readonly setup: AiSetupView
  /** What sits between the heading and the grid: no route yet, a connection needing attention, or "Connected". */
  readonly notice: ReactNode
  readonly onChoose: (route: { readonly provider: Provider; readonly method: Method }, tab: Window | null) => void
  readonly onApiKey: (request: ConnectRequest, tab: Window | null) => void
}) {
  const apiKeyProvider =
    PROVIDERS.find((provider) => routeAvailability(setup, { provider, method: "api_key" }) !== "unproven") ?? null

  return (
    <main className="flex flex-1 justify-center px-4 py-10 sm:px-12 sm:py-12">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink-strong">Connect your AI</h1>
          <p className="mt-1.5 leading-relaxed text-ink-soft">
            Job Kit uses your own AI account to read your CV and draft your profile. It sends the provider your CV,
            profile and public job postings, nothing else.
          </p>
        </div>

        {notice}

        <ProviderGrid setup={setup} onChoose={onChoose} />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Button
            type="button"
            variant="link"
            className="h-auto justify-start p-0 text-[13px] font-normal text-ink-soft"
            disabled={apiKeyProvider === null}
            onClick={() => {
              if (apiKeyProvider !== null) onApiKey({ kind: "apiKey", provider: apiKeyProvider }, null)
            }}
          >
            Use an API key instead
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
            <HugeiconsIcon icon={LockIcon} className="size-3.5" aria-hidden="true" />
            Stored encrypted. Never shown in logs.
          </span>
        </div>
      </div>
    </main>
  )
}

/** Why a stored connection needs attention, as the tail of "Your … connection needs attention: …". */
const ATTENTION_REASON: Record<Exclude<ConnectionStatus, "ready">, string> = {
  revoked: "access was revoked",
  expired: "the sign-in expired",
  quota_exhausted: "the account reached its usage limit",
  unreachable: "the provider isn't responding",
}

function NoRouteNotice() {
  return (
    <Alert role="status">
      <AlertDescription>No AI route is available yet. You can keep using Job Kit in the meantime.</AlertDescription>
    </Alert>
  )
}

function AttentionNotice({
  connection,
  onReconnect,
}: {
  readonly connection: ConnectionView
  readonly onReconnect: () => void
}) {
  const name = PROVIDER_COPY[connection.provider].name
  const reason = connection.status === "ready" ? null : ATTENTION_REASON[connection.status]
  if (reason === null) return null
  return (
    <Alert variant="destructive" className="gap-3">
      <AlertDescription>
        Your {name} connection needs attention: {reason}.
      </AlertDescription>
      <div>
        <Button type="button" onClick={onReconnect}>
          Reconnect {name}
        </Button>
      </div>
    </Alert>
  )
}

/** A7's action after A7 itself was dismissed: the connection is ready and setup only needs finishing. */
function ConnectedBar({
  connection,
  onContinue,
}: {
  readonly connection: ConnectionView
  readonly onContinue: () => void
}) {
  return (
    <div className="flex flex-col gap-3 border border-divider bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderMark provider={connection.provider} />
        <p className="text-sm text-ink-body">
          Connected: <span className="font-medium text-ink-strong">{PROVIDER_COPY[connection.provider].name}</span>
          {" · "}
          {connection.billing}
        </p>
      </div>
      <Button type="button" className="shrink-0" onClick={onContinue}>
        Create my profile
        <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Resume (S2 / A9) — shown once per page load, in place of Connect, while a stale authorization is pending
// ---------------------------------------------------------------------------------------------------------------

function resumeActionLabel(method: Method): string {
  switch (method) {
    case "device":
      return "Get a new code"
    case "setup_token":
    case "api_key":
      return "Enter it again"
    default: {
      const _exhaustiveCheck: never = method
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

function ResumeContent({
  lastAuthorization,
  onResume,
  onChooseAnother,
}: {
  readonly lastAuthorization: NonNullable<AiSetupView["lastAuthorization"]>
  readonly onResume: (request: ConnectRequest, tab: Window | null) => void
  readonly onChooseAnother: () => void
}) {
  const { provider, method, expiresAt } = lastAuthorization
  const name = PROVIDER_COPY[provider].name
  // Only a device route has a code that can expire; an entry route simply wasn't finished.
  const expired = opensTab(method) && !expiresAt.isAfter(POSIX.now())

  const resume = (): void => {
    const request: ConnectRequest =
      method === "api_key" ? { kind: "apiKey", provider } : { kind: "route", route: { provider, method } }
    // Synchronous with the click, so a device tab isn't blocked as script-timed.
    onResume(request, opensTab(method) ? openProviderTab() : null)
  }

  return (
    <main className="flex flex-1 justify-center px-4 py-12 sm:px-12 sm:py-16">
      <div className="flex w-full max-w-lg flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-ink-strong">Welcome back</h1>
          <p className="mt-1.5 text-ink-soft">
            You finished the overview and chose {name} {ROUTE_PHRASE[method]}. We checked where things stand.
          </p>
        </div>

        <div className="flex flex-col gap-4 border border-divider bg-card p-6">
          <ul className="flex flex-col gap-2.5">
            <li className="flex items-start gap-2.5">
              <HugeiconsIcon icon={Tick02Icon} className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              <div className="text-sm text-ink-strong">Overview</div>
            </li>
            <li className="flex items-start gap-2.5">
              <HugeiconsIcon icon={Cancel01Icon} className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
              <div>
                <div className="text-sm text-ink-strong">{name} authorization</div>
                <div className="text-xs text-ink-soft">
                  {expired ?
                    "Your last code expired before it was approved."
                  : `You hadn't finished connecting ${name}.`}
                </div>
              </div>
            </li>
            <li className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 rounded-full border border-dashed border-divider-emphasis"
              />
              <div className="text-sm text-ink-soft">Create profile</div>
            </li>
          </ul>
          <div className="flex gap-2">
            <Button type="button" onClick={resume}>
              {resumeActionLabel(method)}
            </Button>
            <Button type="button" variant="ghost" onClick={onChooseAnother}>
              Choose another route
            </Button>
          </div>
        </div>

        <p className="text-xs text-ink-soft">
          Saved: steps you finished and the route you picked. Never saved: codes, keys or tokens.
        </p>
      </div>
    </main>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The fresh-load A7 dialog: setup.active already exists (a reload mid-flow) and no live ConnectDialog is open.
// ---------------------------------------------------------------------------------------------------------------

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

function formatCheckedAt(checkedAt: POSIX): string {
  const seconds = Math.max(0, POSIX.now().difference(checkedAt).asSeconds())
  if (seconds < 60) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return RELATIVE_TIME.format(-minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 24) return RELATIVE_TIME.format(-hours, "hour")
  return RELATIVE_TIME.format(-Math.round(hours / 24), "day")
}

function ConnectedDialog({
  connection,
  onContinue,
  onClose,
}: {
  readonly connection: ConnectionView
  readonly onContinue: () => void
  readonly onClose: () => void
}) {
  const name = PROVIDER_COPY[connection.provider].name
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-4rem)] gap-0 p-0 sm:max-w-[480px]">
        <ScrollArea viewportProps={{ className: "h-auto max-h-[calc(100dvh-4rem)]" }}>
          <div className="flex flex-col">
            <div className="flex items-start gap-3 px-8 pt-6">
              <ProviderMark provider={connection.provider} />
              <div className="flex-1">
                <DialogTitle className="text-base leading-none font-semibold">{name} is connected</DialogTitle>
                <DialogDescription className="mt-1 text-[13px]">
                  Checked {formatCheckedAt(connection.checkedAt)}
                </DialogDescription>
              </div>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
                <HugeiconsIcon icon={Cancel01Icon} />
              </Button>
            </div>
            <div className="flex flex-col gap-5 px-8 py-6">
              <dl className="grid grid-cols-[128px_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                <dt className="text-ink-muted">Account</dt>
                <dd className="font-mono">{connection.account}</dd>
                <dt className="text-ink-muted">Billed to</dt>
                <dd>{connection.billing}</dd>
                <dt className="text-ink-muted">Model</dt>
                <dd>
                  {connection.models.some((m) => m.id === connection.preferences.model && m.recommended) ?
                    "Recommended · "
                  : null}
                  <span className="font-mono">{connection.preferences.model}</span>
                </dd>
              </dl>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-divider px-8 py-4">
              <Button type="button" variant="ghost" onClick={onClose}>
                Use a different AI
              </Button>
              <Button type="button" onClick={onContinue}>
                Create my profile
                <HugeiconsIcon icon={ArrowRight01Icon} data-icon="inline-end" />
              </Button>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
