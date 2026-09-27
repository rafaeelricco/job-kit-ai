import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { type Maybe, Just, Nothing } from "@lib/maybe"
import { Success, Failure } from "@lib/result"
import { POSIX, Duration } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"

import {
  decideStart,
  decideReady,
  decideConfirmSwitch,
  decideDiscardSwitch,
  decideDisconnect,
  decidePreferences,
  decideStep,
} from "@be/domain/ai/decide"
import { initialAi, type AiState, type Connection } from "@be/domain/workspace/aggregate/aiState"
import { type Route } from "@be/domain/ai/routes"
import { type Capabilities } from "@be/domain/ai/capabilities"
import { type Attempt } from "@be/app/ai/attempts"
import { AiConnectionVerified } from "@be/domain/workspace/events/workspace/aiConnectionVerified"
import { AiConnectionReconnected } from "@be/domain/workspace/events/workspace/aiConnectionReconnected"
import { AiSwitchConfirmed } from "@be/domain/workspace/events/workspace/aiSwitchConfirmed"
import { AiSwitchDiscarded } from "@be/domain/workspace/events/workspace/aiSwitchDiscarded"
import { AiConnectionDisconnected } from "@be/domain/workspace/events/workspace/aiConnectionDisconnected"
import { AiPreferencesChanged } from "@be/domain/workspace/events/workspace/aiPreferencesChanged"
import { SetupStepCompleted } from "@be/domain/workspace/events/workspace/setupStepCompleted"

const workspaceId = new Id<"Workspace">("workspace-1")
const at = new POSIX(1_700_000_000_000)

const CAPS: Capabilities = {
  account: "t•••@example.test",
  billing: "Your OpenAI API account",
  models: [
    {
      id: "test-a",
      summary: "everything",
      recommended: true,
      efforts: ["low", "medium", "high"],
      usable: true,
      reason: null,
    },
  ],
}

function connection(over: Partial<Connection> = {}): Connection {
  return {
    connectionId: Id.random<"AiConnection">(),
    provider: "openai",
    method: "device",
    accountId: "acct-1",
    credentialRef: Id.random<"AiSecret">(),
    capabilities: CAPS,
    preferences: { model: "test-a", effort: "medium" },
    status: "ready",
    checkedAt: at,
    ...over,
  }
}

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: Id.random<"AiAttempt">(),
    workspaceId,
    provider: "openai",
    method: "device",
    purpose: "initial",
    state: "authorized",
    failure: Nothing(),
    challenge: { kind: "device", userCode: "ABCD-EFGH", verificationUrl: "http://x/device" },
    secretRef: Nothing(),
    credentialRef: Nothing(),
    expiresAt: at.addDuration(Duration.minutes(10)),
    ...over,
  }
}

/** `ai.authorization` matching `a`, the shape `decideReady` requires to not be `superseded`. */
function authorizedFor(a: Attempt): AiState["authorization"] {
  return Just({
    attemptId: a.attemptId,
    provider: a.provider,
    method: a.method,
    purpose: a.purpose,
    expiresAt: a.expiresAt,
  })
}

function unwrap<T>(m: Maybe<T>): T {
  if (m instanceof Nothing) throw new Error("expected a Just")
  return m.value
}

describe("decideStart", () => {
  const route: Route = { provider: "openai", method: "device" }

  test("initial: allowed with no active connection", () => {
    assert.deepEqual(decideStart(initialAi, route, "initial"), Success(undefined))
  })

  test("initial: rejected once a connection is active", () => {
    const ai: AiState = { ...initialAi, active: Just(connection()) }
    assert.deepEqual(decideStart(ai, route, "initial"), Failure({ type: "invalid_purpose" }))
  })

  test("reconnect: allowed only for the active connection's own route", () => {
    const ai: AiState = { ...initialAi, active: Just(connection({ provider: "openai", method: "device" })) }
    assert.deepEqual(decideStart(ai, route, "reconnect"), Success(undefined))
    assert.deepEqual(
      decideStart(ai, { provider: "openai", method: "api_key" }, "reconnect"),
      Failure({ type: "invalid_purpose" })
    )
  })

  test("reconnect: rejected with no active connection", () => {
    assert.deepEqual(decideStart(initialAi, route, "reconnect"), Failure({ type: "invalid_purpose" }))
  })

  test("switch: allowed only when a connection is active", () => {
    const ai: AiState = { ...initialAi, active: Just(connection()) }
    assert.deepEqual(decideStart(ai, route, "switch"), Success(undefined))
    assert.deepEqual(decideStart(initialAi, route, "switch"), Failure({ type: "invalid_purpose" }))
  })
})

describe("decideReady", () => {
  const ready = { kind: "ready" as const, accountId: "acct-1", capabilities: CAPS }
  const connectionId = Id.random<"AiConnection">()

  test("an attempt that no longer matches the recorded authorization is superseded", () => {
    const a = attempt({ purpose: "initial" })
    const ai: AiState = { ...initialAi, authorization: Nothing() }
    assert.deepEqual(decideReady(ai, a, Id.random(), ready, connectionId), Failure("superseded"))

    const other = attempt({ purpose: "initial" })
    const staleAi: AiState = { ...initialAi, authorization: authorizedFor(other) }
    assert.deepEqual(decideReady(staleAi, a, Id.random(), ready, connectionId), Failure("superseded"))
  })

  test("initial: superseded once a connection is already active", () => {
    const a = attempt({ purpose: "initial" })
    const ai: AiState = { ...initialAi, authorization: authorizedFor(a), active: Just(connection()) }
    assert.deepEqual(decideReady(ai, a, Id.random(), ready, connectionId), Failure("superseded"))
  })

  test("initial: verifies into an active connection with default preferences", () => {
    const a = attempt({ purpose: "initial" })
    const ai: AiState = { ...initialAi, authorization: authorizedFor(a) }
    const credentialRef = Id.random<"AiSecret">()
    const decided = decideReady(ai, a, credentialRef, ready, connectionId)
    assert.ok(decided instanceof Success)
    assert.equal(decided.value.role, "active")
    assert.deepEqual(decided.value.release, [])
    assert.ok(decided.value.event instanceof AiConnectionVerified)
    assert.equal(decided.value.event.values.role, "active")
    assert.equal(decided.value.event.values.connection.preferences.model, "test-a")
  })

  test("switch: stages the new connection and releases an older staged one", () => {
    const a = attempt({ purpose: "switch" })
    const olderStaged = connection()
    const ai: AiState = {
      ...initialAi,
      authorization: authorizedFor(a),
      active: Just(connection()),
      staged: Just(olderStaged),
    }
    const credentialRef = Id.random<"AiSecret">()
    const decided = decideReady(ai, a, credentialRef, ready, connectionId)
    assert.ok(decided instanceof Success)
    assert.equal(decided.value.role, "staged")
    assert.deepEqual(decided.value.release, [olderStaged.credentialRef])
    assert.ok(decided.value.event instanceof AiConnectionVerified)
    assert.equal(decided.value.event.values.role, "staged")
  })

  test("switch: activates directly when the connection it was meant to protect is gone", () => {
    const a = attempt({ purpose: "switch" })
    const ai: AiState = { ...initialAi, authorization: authorizedFor(a) }
    const decided = decideReady(ai, a, Id.random(), ready, connectionId)
    assert.ok(decided instanceof Success)
    assert.equal(decided.value.role, "active")
    assert.deepEqual(decided.value.release, [])
  })

  test("reconnect: superseded once the active connection moved to a different route", () => {
    const a = attempt({ purpose: "reconnect", provider: "openai", method: "device" })
    const ai: AiState = {
      ...initialAi,
      authorization: authorizedFor(a),
      active: Just(connection({ provider: "openai", method: "api_key" })),
    }
    assert.deepEqual(decideReady(ai, a, Id.random(), ready, connectionId), Failure("superseded"))
  })

  test("reconnect: different_account when the ready credential belongs to someone else", () => {
    const a = attempt({ purpose: "reconnect" })
    const active = connection({ accountId: "acct-1" })
    const ai: AiState = { ...initialAi, authorization: authorizedFor(a), active: Just(active) }
    const otherAccount = { kind: "ready" as const, accountId: "acct-2", capabilities: CAPS }
    assert.deepEqual(decideReady(ai, a, Id.random(), otherAccount, connectionId), Failure("different_account"))
  })

  test("reconnect: refreshes the same connection, keeping preferences that still pass and releasing the old ref", () => {
    const a = attempt({ purpose: "reconnect" })
    const active = connection({ accountId: "acct-1", preferences: { model: "test-a", effort: "high" } })
    const ai: AiState = { ...initialAi, authorization: authorizedFor(a), active: Just(active) }
    const credentialRef = Id.random<"AiSecret">()
    const decided = decideReady(ai, a, credentialRef, ready, connectionId)
    assert.ok(decided instanceof Success)
    assert.equal(decided.value.role, "active")
    assert.deepEqual(decided.value.release, [active.credentialRef])
    assert.ok(decided.value.event instanceof AiConnectionReconnected)
    assert.equal(decided.value.event.values.connectionId.value, active.connectionId.value)
    assert.deepEqual(decided.value.event.values.preferences, { model: "test-a", effort: "high" })
  })

  test("reconnect: resets preferences that no longer pass against the fresh capabilities", () => {
    const a = attempt({ purpose: "reconnect" })
    const active = connection({ accountId: "acct-1", preferences: { model: "gone", effort: "high" } })
    const ai: AiState = { ...initialAi, authorization: authorizedFor(a), active: Just(active) }
    const decided = decideReady(ai, a, Id.random(), ready, connectionId)
    assert.ok(decided instanceof Success)
    assert.ok(decided.value.event instanceof AiConnectionReconnected)
    assert.deepEqual(decided.value.event.values.preferences, { model: "test-a", effort: "medium" })
  })
})

describe("decideConfirmSwitch", () => {
  test("confirms the staged connection and releases the previous active one", () => {
    const active = connection()
    const staged = connection()
    const ai: AiState = { ...initialAi, active: Just(active), staged: Just(staged) }
    const decided = decideConfirmSwitch(ai, workspaceId, staged.connectionId)
    assert.ok(decided instanceof Success)
    const value = unwrap(decided.value)
    assert.ok(value.event instanceof AiSwitchConfirmed)
    assert.deepEqual(value.release, [active.credentialRef])
  })

  test("repeating a confirm once it already applied is a no-op", () => {
    const active = connection()
    const ai: AiState = { ...initialAi, active: Just(active) }
    const decided = decideConfirmSwitch(ai, workspaceId, active.connectionId)
    assert.ok(decided instanceof Success)
    assert.ok(decided.value instanceof Nothing)
  })

  test("an id matching neither active nor staged is not found", () => {
    assert.deepEqual(
      decideConfirmSwitch(initialAi, workspaceId, Id.random()),
      Failure({ type: "connection_not_found" })
    )
  })
})

describe("decideDiscardSwitch", () => {
  test("discards the staged connection, releasing its credential, and leaves active untouched", () => {
    const staged = connection()
    const ai: AiState = { ...initialAi, active: Just(connection()), staged: Just(staged) }
    const decided = decideDiscardSwitch(ai, workspaceId, staged.connectionId)
    assert.ok(decided instanceof Success)
    const value = unwrap(decided.value)
    assert.ok(value.event instanceof AiSwitchDiscarded)
    assert.deepEqual(value.release, [staged.credentialRef])
  })

  test("repeating a discard once nothing is staged is a no-op", () => {
    const decided = decideDiscardSwitch(initialAi, workspaceId, Id.random())
    assert.ok(decided instanceof Success)
    assert.ok(decided.value instanceof Nothing)
  })

  test("a different connection staged than the one named is not found", () => {
    const ai: AiState = { ...initialAi, staged: Just(connection()) }
    assert.deepEqual(decideDiscardSwitch(ai, workspaceId, Id.random()), Failure({ type: "connection_not_found" }))
  })
})

describe("decideDisconnect", () => {
  test("disconnects the active connection, releasing its credential", () => {
    const active = connection()
    const ai: AiState = { ...initialAi, active: Just(active) }
    const decided = decideDisconnect(ai, workspaceId, active.connectionId)
    assert.ok(decided instanceof Success)
    const value = unwrap(decided.value)
    assert.ok(value.event instanceof AiConnectionDisconnected)
    assert.deepEqual(value.release, [active.credentialRef])
  })

  test("repeating a disconnect once nothing is active is a no-op", () => {
    const decided = decideDisconnect(initialAi, workspaceId, Id.random())
    assert.ok(decided instanceof Success)
    assert.ok(decided.value instanceof Nothing)
  })

  test("a different connection active than the one named is not found", () => {
    const ai: AiState = { ...initialAi, active: Just(connection()) }
    assert.deepEqual(decideDisconnect(ai, workspaceId, Id.random()), Failure({ type: "connection_not_found" }))
  })
})

describe("decidePreferences", () => {
  test("saves preferences that pass checkPreferences", () => {
    const active = connection({ preferences: { model: "test-a", effort: "low" } })
    const ai: AiState = { ...initialAi, active: Just(active) }
    const decided = decidePreferences(ai, workspaceId, active.connectionId, { model: "test-a", effort: "high" })
    assert.ok(decided instanceof Success)
    const event = unwrap(decided.value)
    assert.ok(event instanceof AiPreferencesChanged)
    assert.equal(event.values.effort, "high")
  })

  test("rejects preferences that fail checkPreferences", () => {
    const active = connection()
    const ai: AiState = { ...initialAi, active: Just(active) }
    const decided = decidePreferences(ai, workspaceId, active.connectionId, { model: "unknown-model", effort: "low" })
    assert.deepEqual(decided, Failure({ type: "preference_not_allowed", reason: "unknown_model" }))
  })

  test("resaving the same preferences is a no-op", () => {
    const active = connection({ preferences: { model: "test-a", effort: "medium" } })
    const ai: AiState = { ...initialAi, active: Just(active) }
    const decided = decidePreferences(ai, workspaceId, active.connectionId, { model: "test-a", effort: "medium" })
    assert.ok(decided instanceof Success)
    assert.ok(decided.value instanceof Nothing)
  })

  test("connection_not_found when there's no active connection with that id", () => {
    assert.deepEqual(
      decidePreferences(initialAi, workspaceId, Id.random(), { model: "test-a", effort: "low" }),
      Failure({ type: "connection_not_found" })
    )
  })
})

describe("decideStep", () => {
  test("overview completes once and is a no-op after", () => {
    const decided = decideStep(initialAi, workspaceId, "overview")
    assert.ok(decided instanceof Success)
    const event = unwrap(decided.value)
    assert.ok(event instanceof SetupStepCompleted)
    assert.equal(event.values.step, "overview")

    const again = decideStep({ ...initialAi, overviewCompleted: true }, workspaceId, "overview")
    assert.ok(again instanceof Success)
    assert.ok(again.value instanceof Nothing)
  })

  test("connect needs an active connection whose status is ready", () => {
    assert.deepEqual(decideStep(initialAi, workspaceId, "connect"), Failure({ type: "not_ready" }))
    const notReady: AiState = { ...initialAi, active: Just(connection({ status: "revoked" })) }
    assert.deepEqual(decideStep(notReady, workspaceId, "connect"), Failure({ type: "not_ready" }))
  })

  test("connect completes once ready and is a no-op after", () => {
    const ai: AiState = { ...initialAi, active: Just(connection({ status: "ready" })) }
    const decided = decideStep(ai, workspaceId, "connect")
    assert.ok(decided instanceof Success)
    assert.ok(unwrap(decided.value) instanceof SetupStepCompleted)

    const again = decideStep({ ...ai, setupCompleted: true }, workspaceId, "connect")
    assert.ok(again instanceof Success)
    assert.ok(again.value instanceof Nothing)
  })
})
