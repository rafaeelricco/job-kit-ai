export {
  PROVIDERS,
  METHODS,
  EFFORTS,
  PROVIDER_EFFORTS,
  PURPOSES,
  AVAILABILITIES,
  ROUTES,
  schema_Provider,
  schema_Method,
  schema_Effort,
  schema_Purpose,
  schema_Availability,
  schema_Route,
  schema_RouteView,
  isLiveRoute,
  routeViews,
  type Provider,
  type Method,
  type Effort,
  type Purpose,
  type Availability,
  type Route,
  type RouteView,
  type RouteMode,
}

import * as s from "@lib/json/schema"

import type Anthropic from "@anthropic-ai/sdk"
import type OpenAI from "openai"

/** Client-safe: this file (and everything it imports) never reaches pg, mongo, express, node:crypto, or `@be/app/*`. The SDK imports are type-only. */

const PROVIDERS = ["anthropic", "xai"] as const
type Provider = (typeof PROVIDERS)[number]
const schema_Provider = s.stringEnum([...PROVIDERS])

const METHODS = ["device", "setup_token", "api_key"] as const
type Method = (typeof METHODS)[number]
const schema_Method = s.stringEnum([...METHODS])

/** Every level any provider takes, lowest first: the wire enum. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
type Effort = (typeof EFFORTS)[number]
const schema_Effort = s.stringEnum([...EFFORTS])

/**
 * Each provider's levels, checked against its official SDK's own union (commit-tools `config.ts`): a level the SDK
 * drops, or `EFFORTS` lacks, fails the build. xAI speaks the OpenAI chat API, so its levels are that SDK's
 * `reasoning_effort`; Grok rejects it on some models, and `llm/xai.ts` retries without it.
 */
const PROVIDER_EFFORTS = {
  anthropic: ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly (Effort &
    NonNullable<Anthropic.OutputConfig["effort"]>)[],
  xai: ["low", "medium", "high", "xhigh"] as const satisfies readonly (Effort &
    NonNullable<OpenAI.Chat.ChatCompletionCreateParams["reasoning_effort"]>)[],
} satisfies Record<Provider, readonly Effort[]>

const PURPOSES = ["initial", "reconnect", "switch"] as const
type Purpose = (typeof PURPOSES)[number]
const schema_Purpose = s.stringEnum([...PURPOSES])

/** `live`: a real adapter serves the route. `test`: the in-memory test adapter does. `unproven`: nothing does. */
const AVAILABILITIES = ["unproven", "test", "live"] as const
type Availability = (typeof AVAILABILITIES)[number]
const schema_Availability = s.stringEnum([...AVAILABILITIES])

type Route = { provider: Provider; method: Method }
const schema_Route = s.object({ provider: schema_Provider, method: schema_Method })

type RouteView = Route & { availability: Availability }
const schema_RouteView = s.object({
  provider: schema_Provider,
  method: schema_Method,
  availability: schema_Availability,
})

/** The V1 target set from docs/delivery/steps/02-onboarding.md (OpenAI dropped 2026-09-28). Listing a route claims nothing about whether it works. */
const ROUTES: readonly Route[] = [
  { provider: "anthropic", method: "setup_token" },
  { provider: "anthropic", method: "api_key" },
  { provider: "xai", method: "device" },
  { provider: "xai", method: "api_key" },
]

/**
 * API keys, plus xAI's device sign-in (commit-tools `infra/auth/xai.ts`, served by the owner's call on 2026-09-28 though
 * it signs in as xAI's CLI client). Anthropic's setup token stays `unproven`: it poses as Claude Code
 * (docs/research/provider-connections.md:9).
 */
const isLiveRoute = (r: Route): boolean => r.method === "api_key" || (r.provider === "xai" && r.method === "device")

/** How `connections.ts` serves routes: all through the test adapter, API keys for real, or none. */
type RouteMode = "test" | "live" | "off"

const routeViews = (mode: RouteMode): RouteView[] =>
  ROUTES.map((r) => ({
    ...r,
    availability: mode === "test" ? "test" : mode === "live" && isLiveRoute(r) ? "live" : "unproven",
  }))
