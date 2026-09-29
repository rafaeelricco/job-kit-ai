export { ProviderGrid }

import { ArrowRight01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { ProviderMark } from "@module/ai/components/provider-mark"
import {
  CARD_METHOD,
  PROVIDER_COPY,
  PROVIDERS,
  openProviderTab,
  opensTab,
  routeAvailability,
} from "@module/ai/providers"
import { type AiSetupView, type Method, type Provider } from "@module/ai/types"

/**
 * A2's two-column grid: one card per provider, using each provider's `CARD_METHOD` (`setup.tsx` also offers the API
 * key as the secondary link below the grid). The grid opens the provider tab itself for a device card,
 * synchronously inside the click handler, so a popup blocker doesn't see it as script-timed.
 */
function ProviderGrid({
  setup,
  onChoose,
}: {
  readonly setup: AiSetupView
  readonly onChoose: (route: { readonly provider: Provider; readonly method: Method }, tab: Window | null) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {PROVIDERS.map((provider) => {
        const method = CARD_METHOD[provider]
        const copy = PROVIDER_COPY[provider]
        const availability = routeAvailability(setup, { provider, method })
        const disabled = availability === "unproven"
        const tab = opensTab(method)

        const choose = (): void => {
          // Synchronous with the click, so a popup blocker still treats the tab as user-initiated.
          onChoose({ provider, method }, tab ? openProviderTab() : null)
        }

        // No `aria-label`: the card's own text is its accessible name, so a screen reader hears the same name,
        // sign-in line, billing line and chips a sighted user reads. The `{" "}` between flex items render
        // nothing but keep the words apart in that name.
        return (
          <button
            key={provider}
            type="button"
            disabled={disabled}
            onClick={choose}
            className="flex min-h-24 items-center gap-4 border border-divider bg-surface p-5 text-left disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ProviderMark provider={provider} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* The chip rides the name line so the sign-in and billing lines keep their full width. */}
              <span className="flex items-center gap-2">
                <span className="text-base font-semibold text-ink-strong">{copy.name}</span>{" "}
                {availability === "test" ?
                  <code>test adapter</code>
                : null}
              </span>{" "}
              <span className="text-sm text-ink-body">{copy.signIn}</span>{" "}
              <span className="text-xs text-ink-soft">{copy.billing}</span>
            </span>{" "}
            {disabled ?
              <span className="shrink-0 text-xs text-ink-soft">Not available yet</span>
            : <HugeiconsIcon
                icon={tab ? LinkSquare02Icon : ArrowRight01Icon}
                className="size-4 shrink-0 text-ink-soft"
                aria-hidden="true"
              />
            }
            {tab ?
              <span className="sr-only"> (opens in a new tab)</span>
            : null}
          </button>
        )
      })}
    </div>
  )
}
