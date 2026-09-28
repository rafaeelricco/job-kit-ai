export {
  PROVIDERS,
  METHODS,
  EFFORTS,
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

/** Client-safe: this file (and everything it imports) never reaches pg, mongo, express, node:crypto, or `@be/app/*`. */

const PROVIDERS = ["openai", "anthropic", "xai"] as const
type Provider = (typeof PROVIDERS)[number]
const schema_Provider = s.stringEnum([...PROVIDERS])

const METHODS = ["device", "setup_token", "api_key"] as const
type Method = (typeof METHODS)[number]
const schema_Method = s.stringEnum([...METHODS])

const EFFORTS = ["low", "medium", "high"] as const
type Effort = (typeof EFFORTS)[number]
const schema_Effort = s.stringEnum([...EFFORTS])

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

/** The V1 target set from docs/delivery/steps/02-onboarding.md. Listing a route claims nothing about whether it works. */
const ROUTES: readonly Route[] = [
  { provider: "openai", method: "device" },
  { provider: "openai", method: "api_key" },
  { provider: "anthropic", method: "setup_token" },
  { provider: "anthropic", method: "api_key" },
  { provider: "xai", method: "device" },
  { provider: "xai", method: "api_key" },
]

/**
 * Only API keys have a real adapter. commit-tools' subscription sign-ins work by posing as the provider's own CLI
 * (docs/research/provider-connections.md:9), so those routes stay `unproven`.
 */
const isLiveRoute = (r: Route): boolean => r.method === "api_key"

/** How `connections.ts` serves routes: all through the test adapter, API keys for real, or none. */
type RouteMode = "test" | "live" | "off"

const routeViews = (mode: RouteMode): RouteView[] =>
  ROUTES.map((r) => ({
    ...r,
    availability: mode === "test" ? "test" : mode === "live" && isLiveRoute(r) ? "live" : "unproven",
  }))
