export {
  schema_ConnectionStatus,
  schema_ConnectionRecord,
  schema_Connection,
  schema_AiState,
  initialAi,
  applyAiEvent,
  type ConnectionStatus,
  type ConnectionRecord,
  type Connection,
  type AiState,
  type AiEventValues,
}

import * as s from "@lib/json/schema"

import { type Maybe, Just, Nothing } from "@lib/maybe"
import { POSIX } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"

import { schema_Provider, schema_Method, schema_Purpose } from "@be/domain/ai/routes"
import { schema_Capabilities, schema_Preferences } from "@be/domain/ai/capabilities"

// `import type` only: the event classes' `transformAggregate` calls `applyAiEvent`, so a runtime import here would cycle.
import type { SetupStepCompleted } from "@be/domain/workspace/events/workspace/setupStepCompleted"
import type { AiAuthorizationStarted } from "@be/domain/workspace/events/workspace/aiAuthorizationStarted"
import type { AiConnectionVerified } from "@be/domain/workspace/events/workspace/aiConnectionVerified"
import type { AiConnectionReconnected } from "@be/domain/workspace/events/workspace/aiConnectionReconnected"
import type { AiConnectionChecked } from "@be/domain/workspace/events/workspace/aiConnectionChecked"
import type { AiSwitchConfirmed } from "@be/domain/workspace/events/workspace/aiSwitchConfirmed"
import type { AiSwitchDiscarded } from "@be/domain/workspace/events/workspace/aiSwitchDiscarded"
import type { AiConnectionDisconnected } from "@be/domain/workspace/events/workspace/aiConnectionDisconnected"
import type { AiPreferencesChanged } from "@be/domain/workspace/events/workspace/aiPreferencesChanged"

const CONNECTION_STATUSES = ["ready", "revoked", "expired", "quota_exhausted", "unreachable"] as const
type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]
const schema_ConnectionStatus = s.stringEnum([...CONNECTION_STATUSES])

/** The `connection` payload of `AiConnectionVerified`: everything but the runtime-only `status`/`checkedAt`. */
const schema_ConnectionRecord = s.object({
  connectionId: Id.schema<"AiConnection">(),
  provider: schema_Provider,
  method: schema_Method,
  accountId: s.string, // adapter's hashed account subject; reconnect must match it
  credentialRef: Id.schema<"AiSecret">(),
  capabilities: schema_Capabilities,
  preferences: schema_Preferences,
})
type ConnectionRecord = s.Infer<typeof schema_ConnectionRecord>

const schema_Connection = s.object({
  connectionId: Id.schema<"AiConnection">(),
  provider: schema_Provider,
  method: schema_Method,
  accountId: s.string,
  credentialRef: Id.schema<"AiSecret">(),
  capabilities: schema_Capabilities,
  preferences: schema_Preferences,
  status: schema_ConnectionStatus,
  checkedAt: POSIX.schema,
})
type Connection = s.Infer<typeof schema_Connection>

const schema_Authorization = s.object({
  attemptId: Id.schema<"AiAttempt">(),
  provider: schema_Provider,
  method: schema_Method,
  purpose: schema_Purpose,
  expiresAt: POSIX.schema,
})

const schema_AiState = s.object({
  overviewCompleted: s.boolean,
  setupCompleted: s.boolean,
  authorization: s.maybe(schema_Authorization),
  active: s.maybe(schema_Connection),
  staged: s.maybe(schema_Connection),
})
type AiState = s.Infer<typeof schema_AiState>

const initialAi: AiState = {
  overviewCompleted: false,
  setupCompleted: false,
  authorization: Nothing(),
  active: Nothing(),
  staged: Nothing(),
}

/** The union of the nine AI event classes' `values` types, discriminated on `type`. */
type AiEventValues =
  | SetupStepCompleted["values"]
  | AiAuthorizationStarted["values"]
  | AiConnectionVerified["values"]
  | AiConnectionReconnected["values"]
  | AiConnectionChecked["values"]
  | AiSwitchConfirmed["values"]
  | AiSwitchDiscarded["values"]
  | AiConnectionDisconnected["values"]
  | AiPreferencesChanged["values"]

/** Apply one matching connection, `f`; any other connection (or `Nothing`) passes through unchanged. */
function matchConnection(
  connection: Maybe<Connection>,
  id: Id<"AiConnection">,
  f: (c: Connection) => Connection
): Maybe<Connection> {
  return connection.map((c) => (c.connectionId.value === id.value ? f(c) : c))
}

function applySetupStepCompleted(state: AiState, event: SetupStepCompleted["values"]): AiState {
  return event.step === "overview" ? { ...state, overviewCompleted: true } : { ...state, setupCompleted: true }
}

function applyAuthorizationStarted(state: AiState, event: AiAuthorizationStarted["values"]): AiState {
  return {
    ...state,
    authorization: Just({
      attemptId: event.attemptId,
      provider: event.provider,
      method: event.method,
      purpose: event.purpose,
      expiresAt: event.expiresAt,
    }),
  }
}

function applyConnectionVerified(state: AiState, event: AiConnectionVerified["values"], at: POSIX): AiState {
  const connection: Connection = { ...event.connection, status: "ready", checkedAt: at }
  return event.role === "active" ? { ...state, active: Just(connection) } : { ...state, staged: Just(connection) }
}

function applyConnectionReconnected(state: AiState, event: AiConnectionReconnected["values"], at: POSIX): AiState {
  return {
    ...state,
    active: matchConnection(state.active, event.connectionId, (active) => ({
      ...active,
      credentialRef: event.credentialRef,
      capabilities: event.capabilities,
      preferences: event.preferences,
      status: "ready",
      checkedAt: at,
    })),
  }
}

function applyConnectionChecked(state: AiState, event: AiConnectionChecked["values"], at: POSIX): AiState {
  const update = (c: Connection): Connection => ({ ...c, status: event.status, checkedAt: at })
  return {
    ...state,
    active: matchConnection(state.active, event.connectionId, update),
    staged: matchConnection(state.staged, event.connectionId, update),
  }
}

function applySwitchConfirmed(state: AiState, event: AiSwitchConfirmed["values"]): AiState {
  return state.staged.maybe(state, (staged) =>
    staged.connectionId.value === event.connectionId.value
      ? { ...state, active: Just(staged), staged: Nothing() }
      : state
  )
}

function applySwitchDiscarded(state: AiState, event: AiSwitchDiscarded["values"]): AiState {
  return state.staged.maybe(state, (staged) =>
    staged.connectionId.value === event.connectionId.value ? { ...state, staged: Nothing() } : state
  )
}

function applyConnectionDisconnected(state: AiState, event: AiConnectionDisconnected["values"]): AiState {
  return state.active.maybe(state, (active) =>
    active.connectionId.value === event.connectionId.value ? { ...state, active: Nothing() } : state
  )
}

function applyPreferencesChanged(state: AiState, event: AiPreferencesChanged["values"]): AiState {
  return {
    ...state,
    active: matchConnection(state.active, event.connectionId, (active) => ({
      ...active,
      preferences: { model: event.model, effort: event.effort },
    })),
  }
}

/** The one transition function the aggregate and the projection share. */
function applyAiEvent(state: AiState, event: AiEventValues, at: POSIX): AiState {
  switch (event.type) {
    case "SetupStepCompleted":
      return applySetupStepCompleted(state, event)
    case "AiAuthorizationStarted":
      return applyAuthorizationStarted(state, event)
    case "AiConnectionVerified":
      return applyConnectionVerified(state, event, at)
    case "AiConnectionReconnected":
      return applyConnectionReconnected(state, event, at)
    case "AiConnectionChecked":
      return applyConnectionChecked(state, event, at)
    case "AiSwitchConfirmed":
      return applySwitchConfirmed(state, event)
    case "AiSwitchDiscarded":
      return applySwitchDiscarded(state, event)
    case "AiConnectionDisconnected":
      return applyConnectionDisconnected(state, event)
    case "AiPreferencesChanged":
      return applyPreferencesChanged(state, event)
    default:
      return event satisfies never
  }
}
