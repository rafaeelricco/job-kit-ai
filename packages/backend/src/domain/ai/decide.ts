export {
  decideStart,
  decideReady,
  decideConfirmSwitch,
  decideDiscardSwitch,
  decideDisconnect,
  decidePreferences,
  decideStep,
}

import { type Result, Success, Failure } from "@lib/result"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { Id } from "@be/lib/event-sourcing/event"

import { type Route, type Purpose } from "@be/domain/ai/routes"
import { type Preferences, defaultPreferences, checkPreferences } from "@be/domain/ai/capabilities"
import { type Readiness } from "@be/domain/ai/adapter"
import { type AiState, type ConnectionRecord } from "@be/domain/workspace/aggregate/aiState"
import { type Attempt } from "@be/app/ai/attempts"
import { type AiError } from "@be/domain/ai/command/aiErrors"

import { AiConnectionVerified } from "@be/domain/workspace/events/workspace/aiConnectionVerified"
import { AiConnectionReconnected } from "@be/domain/workspace/events/workspace/aiConnectionReconnected"
import { AiSwitchConfirmed } from "@be/domain/workspace/events/workspace/aiSwitchConfirmed"
import { AiSwitchDiscarded } from "@be/domain/workspace/events/workspace/aiSwitchDiscarded"
import { AiConnectionDisconnected } from "@be/domain/workspace/events/workspace/aiConnectionDisconnected"
import { AiPreferencesChanged } from "@be/domain/workspace/events/workspace/aiPreferencesChanged"
import { SetupStepCompleted } from "@be/domain/workspace/events/workspace/setupStepCompleted"

/** The `{ kind: "ready" }` half of `Readiness`: the only variant that can ever produce a connection. */
type ReadyReadiness = Extract<Readiness, { kind: "ready" }>

/**
 * Pure invariants, run inside `withEventStore`. Every function here reads the aggregate's current `AiState` and
 * decides what (if anything) to emit; none of them touch the vault, an adapter, or the clock — that's `authorize.ts`,
 * which runs outside the transaction because the event store's generator can re-run on a version conflict.
 */

/**
 * Whether `route`/`purpose` is a legal thing to start authorizing right now.
 * `initial` needs no active connection; `reconnect` needs an active connection on the same route; `switch` needs any
 * active connection. Anything else is `invalid_purpose` (e.g. `initial` while a connection is already active).
 */
function decideStart(ai: AiState, route: Route, purpose: Purpose): Result<AiError, void> {
  switch (purpose) {
    case "initial":
      return ai.active instanceof Nothing ? Success(undefined) : Failure({ type: "invalid_purpose" })
    case "reconnect":
      return ai.active instanceof Just &&
        ai.active.value.provider === route.provider &&
        ai.active.value.method === route.method
        ? Success(undefined)
        : Failure({ type: "invalid_purpose" })
    case "switch":
      return ai.active instanceof Just ? Success(undefined) : Failure({ type: "invalid_purpose" })
    default:
      return purpose satisfies never
  }
}

/**
 * The verdict once a credential has verified `ready`: which event (if any) to emit and which secrets to release
 * afterward. `attempt` (not just its id) carries the `workspaceId` an event needs to stamp `aggregateId`.
 *
 * - The attempt must still be the aggregate's recorded authorization, or the result is `"superseded"` (a late
 *   result from an attempt a newer one, a cancel, or a fresh `start` has since replaced).
 * - `initial`: a connection must not already be active (else `"superseded"`) — emits `AiConnectionVerified(active)`.
 * - `switch`: emits `AiConnectionVerified(staged)`, releasing the credential of the older staged connection it
 *   replaces, if any. Emits `(active)` instead if the connection this was meant to protect was disconnected while the
 *   switch was in flight; that leaves any older staged connection, and its credential, in place.
 * - `reconnect`: the active connection must still be on the same route (else `"superseded"`); a different account
 *   than the one already active is `"different_account"`, except on `api_key`, whose `accountId` names the key rather
 *   than the account, so no replacement key could match it. Emits `AiConnectionReconnected`, releasing the old
 *   credential. Preferences are kept when they still pass `checkPreferences` against the fresh capabilities, else
 *   reset to the default.
 */
type ReadyResult = Result<
  AiError | "superseded" | "different_account",
  { event: AiConnectionVerified | AiConnectionReconnected; release: Id<"AiSecret">[]; role: "active" | "staged" }
>

function decideReady(
  ai: AiState,
  attempt: Attempt,
  credentialRef: Id<"AiSecret">,
  ready: ReadyReadiness,
  connectionId: Id<"AiConnection">
): ReadyResult {
  if (!(ai.authorization instanceof Just) || ai.authorization.value.attemptId.value !== attempt.attemptId.value) {
    return Failure("superseded")
  }

  switch (attempt.purpose) {
    case "initial":
      return decideReadyInitial(ai, attempt, credentialRef, ready, connectionId)
    case "switch":
      return decideReadySwitch(ai, attempt, credentialRef, ready, connectionId)
    case "reconnect":
      return decideReadyReconnect(ai, attempt, credentialRef, ready)
    default:
      return attempt.purpose satisfies never
  }
}

function newConnection(
  attempt: Attempt,
  credentialRef: Id<"AiSecret">,
  ready: ReadyReadiness,
  connectionId: Id<"AiConnection">
): ConnectionRecord {
  return {
    connectionId,
    provider: attempt.provider,
    method: attempt.method,
    accountId: ready.accountId,
    credentialRef,
    capabilities: ready.capabilities,
    preferences: defaultPreferences(ready.capabilities),
  }
}

/** No connection may already be active, or a newer purpose has since raced ahead of this one. */
function decideReadyInitial(
  ai: AiState,
  attempt: Attempt,
  credentialRef: Id<"AiSecret">,
  ready: ReadyReadiness,
  connectionId: Id<"AiConnection">
): ReadyResult {
  if (ai.active instanceof Just) return Failure("superseded")
  return Success({
    event: new AiConnectionVerified({
      type: AiConnectionVerified.type,
      aggregateId: attempt.workspaceId,
      attemptId: attempt.attemptId,
      role: "active",
      connection: newConnection(attempt, credentialRef, ready, connectionId),
    }),
    release: [],
    role: "active",
  })
}

/** Stages the new connection, unless the one it was meant to protect is already gone — then it just activates. */
function decideReadySwitch(
  ai: AiState,
  attempt: Attempt,
  credentialRef: Id<"AiSecret">,
  ready: ReadyReadiness,
  connectionId: Id<"AiConnection">
): ReadyResult {
  const role: "active" | "staged" = ai.active instanceof Just ? "staged" : "active"
  // Only a staged verify replaces `staged`; an active one leaves it (and the credential it still needs) alone.
  const release = role === "staged" && ai.staged instanceof Just ? [ai.staged.value.credentialRef] : []
  return Success({
    event: new AiConnectionVerified({
      type: AiConnectionVerified.type,
      aggregateId: attempt.workspaceId,
      attemptId: attempt.attemptId,
      role,
      connection: newConnection(attempt, credentialRef, ready, connectionId),
    }),
    release,
    role,
  })
}

/** The active connection must still be on the same route and, unless it is an API key, the same account. */
function decideReadyReconnect(
  ai: AiState,
  attempt: Attempt,
  credentialRef: Id<"AiSecret">,
  ready: ReadyReadiness
): ReadyResult {
  if (
    !(ai.active instanceof Just) ||
    ai.active.value.provider !== attempt.provider ||
    ai.active.value.method !== attempt.method
  ) {
    return Failure("superseded")
  }
  const active = ai.active.value
  if (active.method !== "api_key" && active.accountId !== ready.accountId) return Failure("different_account")
  const preferences =
    checkPreferences(ready.capabilities, active.preferences) instanceof Success
      ? active.preferences
      : defaultPreferences(ready.capabilities)
  return Success({
    event: new AiConnectionReconnected({
      type: AiConnectionReconnected.type,
      aggregateId: attempt.workspaceId,
      attemptId: attempt.attemptId,
      connectionId: active.connectionId,
      credentialRef,
      capabilities: ready.capabilities,
      preferences,
    }),
    release: [active.credentialRef],
    role: "active",
  })
}

/**
 * Confirm a staged switch: the staged connection becomes active and the previous active connection's credential is
 * released. `Nothing` when `id` is already the active connection and nothing is staged (a repeated confirm), so
 * retries succeed without emitting a second event. `connection_not_found` when `id` names neither the staged nor
 * the active connection.
 */
function decideConfirmSwitch(
  ai: AiState,
  workspaceId: Id<"Workspace">,
  id: Id<"AiConnection">
): Result<AiError, Maybe<{ event: AiSwitchConfirmed; release: Id<"AiSecret">[] }>> {
  if (ai.staged instanceof Just && ai.staged.value.connectionId.value === id.value) {
    // The replaced credential is deleted on confirm, so a staged connection that stopped passing its check must not replace a working one.
    if (ai.staged.value.status !== "ready") return Failure({ type: "not_ready" })
    const release = ai.active instanceof Just ? [ai.active.value.credentialRef] : []
    return Success(
      Just({
        event: new AiSwitchConfirmed({ type: AiSwitchConfirmed.type, aggregateId: workspaceId, connectionId: id }),
        release,
      })
    )
  }
  if (ai.active instanceof Just && ai.active.value.connectionId.value === id.value) return Success(Nothing())
  return Failure({ type: "connection_not_found" })
}

/**
 * Discard a staged switch: the staged connection's credential is released and the active connection is left alone.
 * `Nothing` when nothing is staged at all (a repeated discard), `connection_not_found` when something else entirely
 * is staged.
 */
function decideDiscardSwitch(
  ai: AiState,
  workspaceId: Id<"Workspace">,
  id: Id<"AiConnection">
): Result<AiError, Maybe<{ event: AiSwitchDiscarded; release: Id<"AiSecret">[] }>> {
  if (ai.staged instanceof Nothing) return Success(Nothing())
  if (ai.staged.value.connectionId.value !== id.value) return Failure({ type: "connection_not_found" })
  return Success(
    Just({
      event: new AiSwitchDiscarded({ type: AiSwitchDiscarded.type, aggregateId: workspaceId, connectionId: id }),
      release: [ai.staged.value.credentialRef],
    })
  )
}

/**
 * Disconnect the active connection, releasing its credential. `Nothing` when nothing is active at all (a repeated
 * disconnect), `connection_not_found` when a different connection is active.
 */
function decideDisconnect(
  ai: AiState,
  workspaceId: Id<"Workspace">,
  id: Id<"AiConnection">
): Result<AiError, Maybe<{ event: AiConnectionDisconnected; release: Id<"AiSecret">[] }>> {
  if (ai.active instanceof Nothing) return Success(Nothing())
  if (ai.active.value.connectionId.value !== id.value) return Failure({ type: "connection_not_found" })
  return Success(
    Just({
      event: new AiConnectionDisconnected({
        type: AiConnectionDisconnected.type,
        aggregateId: workspaceId,
        connectionId: id,
      }),
      release: [ai.active.value.credentialRef],
    })
  )
}

/**
 * Save preferences on the active connection. `connection_not_found` when `id` isn't the active connection;
 * `preference_not_allowed` when `checkPreferences` rejects them (the API applies this gate whatever the UI sent);
 * `Nothing` when they match what's already saved, so a resubmit doesn't emit a redundant event.
 */
function decidePreferences(
  ai: AiState,
  workspaceId: Id<"Workspace">,
  id: Id<"AiConnection">,
  preferences: Preferences
): Result<AiError, Maybe<AiPreferencesChanged>> {
  if (!(ai.active instanceof Just) || ai.active.value.connectionId.value !== id.value) {
    return Failure({ type: "connection_not_found" })
  }
  const active = ai.active.value
  const checked = checkPreferences(active.capabilities, preferences)
  if (checked instanceof Failure) return Failure({ type: "preference_not_allowed", reason: checked.error })
  const next = checked.value
  if (active.preferences.model === next.model && active.preferences.effort === next.effort) return Success(Nothing())
  return Success(
    Just(
      new AiPreferencesChanged({
        type: AiPreferencesChanged.type,
        aggregateId: workspaceId,
        connectionId: id,
        model: next.model,
        effort: next.effort,
      })
    )
  )
}

/**
 * Mark a setup step done. `overview` always applies; `connect` needs an active connection whose status is `"ready"`
 * (else `not_ready`). Either way, a step already marked done emits nothing.
 */
function decideStep(
  ai: AiState,
  workspaceId: Id<"Workspace">,
  step: "overview" | "connect"
): Result<AiError, Maybe<SetupStepCompleted>> {
  if (step === "connect" && (!(ai.active instanceof Just) || ai.active.value.status !== "ready")) {
    return Failure({ type: "not_ready" })
  }
  const alreadyDone = step === "overview" ? ai.overviewCompleted : ai.setupCompleted
  return alreadyDone
    ? Success(Nothing())
    : Success(Just(new SetupStepCompleted({ type: SetupStepCompleted.type, aggregateId: workspaceId, step })))
}
