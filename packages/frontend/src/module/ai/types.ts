export {
  type AiSetupView,
  type ConnectionView,
  type RouteView,
  type Provider,
  type Method,
  type Purpose,
  type Effort,
  type Model,
  type AuthorizationStatus,
  type Challenge,
  type FailureReason,
  type ConnectionStatus,
}

import * as s from "@lib/json/schema"
import { api } from "@api/endpoints"

/**
 * Every AI type the module needs, derived from the endpoint schemas rather than imported from `@be/domain/*`
 * directly (`packages/frontend/CLAUDE.md`: "Server endpoints are reached through `api` ... never imported from `@be/domain/*`
 * directly"). `s.Infer` reads the runtime schema on `api.*`, so these stay in lockstep with the server's contracts
 * without a second, hand-written copy.
 */

/** The whole AI setup snapshot: routes, progress flags, and the active/staged connections. */
type AiSetupView = s.Infer<typeof api.aiSetup.response>

/** One connection's client-safe view (no secret reference, no raw account id). */
type ConnectionView = NonNullable<AiSetupView["active"]>

/** One offered (provider, method) pair and whether it's usable yet. */
type RouteView = AiSetupView["routes"][number]

type Provider = RouteView["provider"]

type Method = RouteView["method"]

/** Why a connect flow was started: fresh setup, a reconnect after it stopped working, or a switch to a new AI. */
type Purpose = s.Infer<typeof api.startAiAuthorization.request>["purpose"]

type Model = ConnectionView["models"][number]

type Effort = Model["efforts"][number]

/** `pending` (device code, or a bare entry form) · `failed` · `connected`. */
type AuthorizationStatus = s.Infer<typeof api.startAiAuthorization.response>["status"]

/** The `pending` half of `AuthorizationStatus`: device code, or a bare entry form. */
type Challenge = Extract<AuthorizationStatus, { status: "pending" }>["challenge"]

/** The `failed` half of `AuthorizationStatus`: why verification or sign-in didn't finish. */
type FailureReason = Extract<AuthorizationStatus, { status: "failed" }>["reason"]

/** A settled connection's health, as opposed to the broader `FailureReason` an authorization attempt can fail with. */
type ConnectionStatus = ConnectionView["status"]
