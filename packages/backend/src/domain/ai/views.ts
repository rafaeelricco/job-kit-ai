export {
  schema_Challenge,
  schema_FailureReason,
  schema_ConnectionView,
  schema_AiSetupView,
  schema_AuthorizationStatus,
  toSetupView,
  type Challenge,
  type FailureReason,
  type ConnectionView,
  type AiSetupView,
  type AuthorizationStatus,
}

import * as s from "@lib/json/schema"

import { POSIX } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"

import { schema_Provider, schema_Method, schema_Purpose, schema_RouteView, type RouteView } from "@be/domain/ai/routes"
import { schema_Model, schema_Preferences } from "@be/domain/ai/capabilities"
import { schema_ConnectionStatus } from "@be/domain/workspace/aggregate/aiState"
import type { AiState, Connection } from "@be/domain/workspace/aggregate/aiState"

/** Client-safe: this file (and everything it imports) never reaches pg, mongo, express, node:crypto, or `@be/app/*`. */

/** device: userCode + verificationUrl · entry: a bare form (token / api key). */
const schema_Challenge = s.discriminatedUnion([
  s.variant({ kind: "device", userCode: s.string, verificationUrl: s.string }),
  s.variant({ kind: "entry" }),
])
type Challenge = s.Infer<typeof schema_Challenge>

const FAILURE_REASONS = [
  "denied",
  "expired",
  "invalid",
  "revoked",
  "quota_exhausted",
  "unreachable",
  "different_account",
  "cancelled",
  "superseded",
] as const
type FailureReason = (typeof FAILURE_REASONS)[number]
const schema_FailureReason = s.stringEnum([...FAILURE_REASONS])

/** DTO for one connection: no `credentialRef`, no `accountId` — only what the browser is allowed to see. */
const schema_ConnectionView = s.object({
  connectionId: Id.schema<"AiConnection">(),
  provider: schema_Provider,
  method: schema_Method,
  account: s.string, // masked, from Capabilities
  billing: s.string,
  status: schema_ConnectionStatus,
  checkedAt: POSIX.schema,
  models: s.array(schema_Model),
  preferences: schema_Preferences,
})
type ConnectionView = s.Infer<typeof schema_ConnectionView>

const schema_LastAuthorization = s.object({
  provider: schema_Provider,
  method: schema_Method,
  purpose: schema_Purpose,
  expiresAt: POSIX.schema,
})

const schema_AiSetupView = s.object({
  routes: s.array(schema_RouteView),
  overviewCompleted: s.boolean,
  setupCompleted: s.boolean,
  lastAuthorization: s.nullable(schema_LastAuthorization),
  active: s.nullable(schema_ConnectionView),
  staged: s.nullable(schema_ConnectionView),
})
type AiSetupView = s.Infer<typeof schema_AiSetupView>

const schema_AuthorizationStatus = s.discriminatedUnion([
  s.variant({ status: "pending", challenge: schema_Challenge, expiresAt: POSIX.schema }),
  s.variant({ status: "failed", reason: schema_FailureReason, retry: s.stringEnum(["verify", "restart"]) }),
  s.variant({ status: "connected", role: s.stringEnum(["active", "staged"]) }),
])
type AuthorizationStatus = s.Infer<typeof schema_AuthorizationStatus>

function toConnectionView(connection: Connection): ConnectionView {
  return {
    connectionId: connection.connectionId,
    provider: connection.provider,
    method: connection.method,
    account: connection.capabilities.account,
    billing: connection.capabilities.billing,
    status: connection.status,
    checkedAt: connection.checkedAt,
    models: connection.capabilities.models,
    preferences: connection.preferences,
  }
}

function toSetupView(ai: AiState, routes: RouteView[]): AiSetupView {
  return {
    routes,
    overviewCompleted: ai.overviewCompleted,
    setupCompleted: ai.setupCompleted,
    lastAuthorization: ai.authorization
      .map((a) => ({ provider: a.provider, method: a.method, purpose: a.purpose, expiresAt: a.expiresAt }))
      .asNullable(),
    active: ai.active.map(toConnectionView).asNullable(),
    staged: ai.staged.map(toConnectionView).asNullable(),
  }
}
