export { PROVIDER_COPY, CARD_METHOD, PROVIDERS, methodLabel, opensTab, openProviderTab, routeAvailability }

import { type AiSetupView, type Method, type Provider, type RouteView } from "@module/ai/types"

type ProviderCopy = {
  readonly name: string
  readonly mark: string
  readonly signIn: string
  readonly billing: string
  readonly keyHint: string
  readonly keyPlaceholder: string
}

/** Artboard copy per provider (A2 cards, A5/A6 entry forms). */
const PROVIDER_COPY: Record<Provider, ProviderCopy> = {
  openai: {
    name: "OpenAI",
    mark: "OA",
    signIn: "Sign in with ChatGPT",
    billing: "Uses your ChatGPT plan",
    keyHint: "Create one in your OpenAI API dashboard.",
    keyPlaceholder: "sk-…",
  },
  anthropic: {
    name: "Anthropic",
    mark: "AN",
    signIn: "Paste a Claude setup token",
    billing: "Uses your Claude subscription",
    keyHint: "Create one in the Anthropic Console.",
    keyPlaceholder: "sk-ant-…",
  },
  xai: {
    name: "xAI",
    mark: "XA",
    signIn: "Sign in with xAI",
    billing: "Uses your xAI account",
    keyHint: "Create one in the xAI console.",
    keyPlaceholder: "xai-…",
  },
}

/** The one card each provider gets in A2. An API key is always the secondary link, never a card of its own. */
const CARD_METHOD: Record<Provider, Method> = {
  openai: "device",
  anthropic: "setup_token",
  xai: "device",
}

/** Card order, left to right / top to bottom in A2 and the provider toggle. */
const PROVIDERS = ["openai", "anthropic", "xai"] as const satisfies readonly Provider[]

/** A settled connection's sign-in method, past tense, for the settings panel and switch-confirm copy. */
function methodLabel(provider: Provider, method: Method): string {
  switch (method) {
    case "device":
      return PROVIDER_COPY[provider].signIn.replace(/^Sign in /, "Signed in ")
    case "setup_token":
      return "Setup token"
    case "api_key":
      return "API key"
    default: {
      const _exhaustiveCheck: never = method
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/** `device` hands off to a provider tab; `setup_token`/`api_key` stay on a bare entry form. */
function opensTab(method: Method): boolean {
  return method === "device"
}

/**
 * Opens a blank tab for a device handoff. MUST be called synchronously inside the click handler that starts
 * the flow — a `window.open` reached through an `await` or a state update loses the user-gesture context and is
 * blocked by every popup blocker. `null` means it was blocked anyway; callers fall back to a plain link.
 */
function openProviderTab(): Window | null {
  return window.open("about:blank", "_blank")
}

/** A route's offered availability, or `"unproven"` when it isn't in `setup.routes` at all (should not happen). */
function routeAvailability(
  setup: AiSetupView,
  route: { provider: Provider; method: Method }
): RouteView["availability"] {
  return (
    setup.routes.find((r) => r.provider === route.provider && r.method === route.method)?.availability ?? "unproven"
  )
}
