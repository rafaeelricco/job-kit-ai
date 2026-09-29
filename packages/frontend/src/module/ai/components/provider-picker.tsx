export { ProviderPicker }

import { ArrowRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { cn } from "@components/utils"
import { Button } from "@ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@ui/dialog"
import { ScrollArea } from "@ui/scroll-area"

import { type ConnectRequest } from "@module/ai/components/connect-dialog"
import { ProviderMark } from "@module/ai/components/provider-mark"
import {
  CARD_METHOD,
  PROVIDER_COPY,
  PROVIDERS,
  methodLabel,
  openProviderTab,
  opensTab,
  routeAvailability,
} from "@module/ai/providers"
import { type AiSetupView, type Method, type Provider } from "@module/ai/types"

/** The card's sign-in line, past-tense-free (unlike `methodLabel`'s "Signed in with xAI"): "xAI sign-in", "API key". */
function cardSignInLabel(provider: Provider): string {
  const method = CARD_METHOD[provider]
  return method === "device" ?
      `${PROVIDER_COPY[provider].signIn.replace(/^Sign in with /, "")} sign-in`
    : methodLabel(provider, method)
}

/** "Uses your xAI account" -> "xAI account": the row's second half, after the sign-in method. */
function billingBasis(provider: Provider): string {
  return PROVIDER_COPY[provider].billing.replace(/^Uses your /, "")
}

/**
 * S4 — the switch/initial provider picker. `purpose: "switch"` disables and chips the current provider's row;
 * `purpose: "initial"` has no current connection to exclude. Picking a row hands the caller a `ConnectRequest`
 * (and, for a tab route, the tab already opened synchronously in this click) so it can open `ConnectDialog`.
 */
function ProviderPicker({
  setup,
  purpose,
  onClose,
  onPick,
}: {
  readonly setup: AiSetupView
  readonly purpose: "initial" | "switch"
  readonly onClose: () => void
  readonly onPick: (request: ConnectRequest, tab: Window | null) => void
}) {
  const current = setup.active

  const pickRoute = (provider: Provider, method: Method): void => {
    // Synchronous, inside the click handler: a `window.open` reached through an `await` loses the user-gesture
    // context and is blocked by every popup blocker.
    const tab = opensTab(method) ? openProviderTab() : null
    onPick(method === "api_key" ? { kind: "apiKey", provider } : { kind: "route", route: { provider, method } }, tab)
  }

  const pickApiKey = (): void => {
    onPick({ kind: "apiKey", provider: PROVIDERS[0] }, null)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-4rem)] gap-0 p-0 sm:max-w-[460px]">
        <ScrollArea viewportProps={{ className: "h-auto max-h-[calc(100dvh-4rem)]" }}>
          <div className="flex items-start justify-between gap-3 px-7 pt-6">
            <div>
              <DialogTitle className="text-base leading-none font-semibold">
                {purpose === "switch" ? "Switch provider" : "Connect an AI"}
              </DialogTitle>
              {purpose === "switch" && current !== null ?
                <DialogDescription className="mt-1 text-[13px]">
                  {PROVIDER_COPY[current.provider].name} stays in use until the new one passes its test.
                </DialogDescription>
              : null}
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
              <HugeiconsIcon icon={Cancel01Icon} />
            </Button>
          </div>
          <div className="flex flex-col gap-3 px-7 py-5">
            {PROVIDERS.map((provider) => {
              const method = CARD_METHOD[provider]
              const availability = routeAvailability(setup, { provider, method })
              const isCurrent = current !== null && current.provider === provider
              const disabled = isCurrent || availability === "unproven"
              return (
                <button
                  key={provider}
                  type="button"
                  disabled={disabled}
                  onClick={() => pickRoute(provider, method)}
                  className={cn(
                    "flex items-center gap-3 border border-divider px-3.5 py-3 text-left transition-colors",
                    disabled ? "cursor-not-allowed bg-inset text-ink-faint" : "bg-surface hover:bg-accent/50"
                  )}
                >
                  <ProviderMark provider={provider} />
                  <span className="flex flex-1 flex-col">
                    <span className={cn("font-medium", disabled && !isCurrent ? "text-ink-faint" : "text-ink-strong")}>
                      {PROVIDER_COPY[provider].name}
                    </span>
                    <span className="text-xs text-ink-soft">
                      {availability === "unproven" ?
                        "Not available yet"
                      : `${cardSignInLabel(provider)} · ${billingBasis(provider)}`}
                    </span>
                  </span>
                  {isCurrent ?
                    <code>current</code>
                  : availability === "test" ?
                    <code>test adapter</code>
                  : <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className="size-4 shrink-0 text-ink-soft"
                      aria-hidden="true"
                    />
                  }
                </button>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-divider px-7 py-3.5">
            <button
              type="button"
              onClick={pickApiKey}
              className="text-[13px] text-ink-soft underline underline-offset-3 hover:text-ink-strong"
            >
              Use an API key instead
            </button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
