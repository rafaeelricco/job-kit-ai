import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { type Maybe, Just, Nothing } from "@lib/maybe"
import { Success } from "@lib/result"
import * as s from "@lib/json/schema"
import { POSIX } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"

import {
  initialAi,
  applyAiEvent,
  schema_AiState,
  type AiState,
  type Connection,
  type ConnectionRecord,
} from "@be/domain/workspace/aggregate/aiState"
import { toSetupView } from "@be/domain/ai/views"
import { routeViews } from "@be/domain/ai/routes"

const workspaceId = new Id<"Workspace">("workspace-1")
const at = new POSIX(1_700_000_000_000)

function record(over: Partial<ConnectionRecord> & { connectionId: Id<"AiConnection"> }): ConnectionRecord {
  return {
    provider: "xai",
    method: "device",
    accountId: "hash-1",
    credentialRef: new Id<"AiSecret">("secret-1"),
    capabilities: { account: "acct", billing: "billing", models: [] },
    preferences: { model: "test-a", effort: "medium" },
    ...over,
  }
}

function connection(over: Partial<Connection> & { connectionId: Id<"AiConnection"> }): Connection {
  return { ...record(over), status: "ready", checkedAt: new POSIX(0), ...over }
}

function unwrap<T>(m: Maybe<T>): T {
  if (m instanceof Nothing) throw new Error("expected a Just")
  return m.value
}

describe("ai state", () => {
  test("SetupStepCompleted sets overview and connect independently", () => {
    const overview = applyAiEvent(
      initialAi,
      { type: "SetupStepCompleted", aggregateId: workspaceId, step: "overview" },
      at
    )
    assert.equal(overview.overviewCompleted, true)
    assert.equal(overview.setupCompleted, false)

    const connect = applyAiEvent(
      initialAi,
      { type: "SetupStepCompleted", aggregateId: workspaceId, step: "connect" },
      at
    )
    assert.equal(connect.setupCompleted, true)
    assert.equal(connect.overviewCompleted, false)
  })

  test("AiAuthorizationStarted records the pending attempt", () => {
    const attemptId = new Id<"AiAttempt">("attempt-1")
    const expiresAt = new POSIX(2000)
    const next = applyAiEvent(
      initialAi,
      {
        type: "AiAuthorizationStarted",
        aggregateId: workspaceId,
        attemptId,
        provider: "xai",
        method: "device",
        purpose: "initial",
        expiresAt,
      },
      at
    )
    assert.equal(next.authorization instanceof Just, true)
    assert.deepEqual(unwrap(next.authorization), {
      attemptId,
      provider: "xai",
      method: "device",
      purpose: "initial",
      expiresAt,
    })
  })

  test("AiConnectionVerified activates on role active and stages on role staged, leaving the other untouched", () => {
    const attemptId = new Id<"AiAttempt">("attempt-1")
    const activeId = new Id<"AiConnection">("conn-active")
    const afterActive = applyAiEvent(
      initialAi,
      {
        type: "AiConnectionVerified",
        aggregateId: workspaceId,
        attemptId,
        role: "active",
        connection: record({ connectionId: activeId }),
      },
      at
    )
    assert.equal(afterActive.active instanceof Just, true)
    assert.deepEqual(unwrap(afterActive.active), {
      ...record({ connectionId: activeId }),
      status: "ready",
      checkedAt: at,
    })
    assert.equal(afterActive.staged instanceof Nothing, true)

    const stagedId = new Id<"AiConnection">("conn-staged")
    const laterAt = new POSIX(at.value + 1000)
    const afterStaged = applyAiEvent(
      afterActive,
      {
        type: "AiConnectionVerified",
        aggregateId: workspaceId,
        attemptId,
        role: "staged",
        connection: record({ connectionId: stagedId }),
      },
      laterAt
    )
    assert.deepEqual(unwrap(afterStaged.active), unwrap(afterActive.active))
    assert.deepEqual(unwrap(afterStaged.staged), {
      ...record({ connectionId: stagedId }),
      status: "ready",
      checkedAt: laterAt,
    })
  })

  test("AiConnectionReconnected refreshes the matching active connection and ignores a different id", () => {
    const activeId = new Id<"AiConnection">("conn-active")
    const before: AiState = {
      ...initialAi,
      active: Just(connection({ connectionId: activeId, status: "expired", checkedAt: new POSIX(0) })),
    }
    const newRef = new Id<"AiSecret">("secret-2")
    const newCaps = { account: "acct2", billing: "billing2", models: [] }
    const newPrefs = { model: "test-b", effort: "high" as const }

    const matched = applyAiEvent(
      before,
      {
        type: "AiConnectionReconnected",
        aggregateId: workspaceId,
        attemptId: new Id("attempt-1"),
        connectionId: activeId,
        credentialRef: newRef,
        capabilities: newCaps,
        preferences: newPrefs,
      },
      at
    )
    assert.deepEqual(unwrap(matched.active), {
      ...connection({ connectionId: activeId }),
      credentialRef: newRef,
      capabilities: newCaps,
      preferences: newPrefs,
      status: "ready",
      checkedAt: at,
    })

    const unmatched = applyAiEvent(
      before,
      {
        type: "AiConnectionReconnected",
        aggregateId: workspaceId,
        attemptId: new Id("attempt-1"),
        connectionId: new Id("some-other-id"),
        credentialRef: newRef,
        capabilities: newCaps,
        preferences: newPrefs,
      },
      at
    )
    assert.deepEqual(unmatched, before)
  })

  test("AiConnectionChecked updates whichever of active/staged matches, and nothing on a miss", () => {
    const activeId = new Id<"AiConnection">("conn-active")
    const stagedId = new Id<"AiConnection">("conn-staged")
    const before: AiState = {
      ...initialAi,
      active: Just(connection({ connectionId: activeId })),
      staged: Just(connection({ connectionId: stagedId })),
    }

    const activeChecked = applyAiEvent(
      before,
      { type: "AiConnectionChecked", aggregateId: workspaceId, connectionId: activeId, status: "revoked" },
      at
    )
    assert.equal(activeChecked.active.withDefault(connection({ connectionId: activeId })).status, "revoked")
    assert.equal(activeChecked.active.withDefault(connection({ connectionId: activeId })).checkedAt.value, at.value)
    assert.deepEqual(unwrap(activeChecked.staged), unwrap(before.staged))

    const stagedChecked = applyAiEvent(
      before,
      { type: "AiConnectionChecked", aggregateId: workspaceId, connectionId: stagedId, status: "quota_exhausted" },
      at
    )
    assert.equal(stagedChecked.staged.withDefault(connection({ connectionId: stagedId })).status, "quota_exhausted")
    assert.deepEqual(unwrap(stagedChecked.active), unwrap(before.active))

    const missed = applyAiEvent(
      before,
      { type: "AiConnectionChecked", aggregateId: workspaceId, connectionId: new Id("unknown"), status: "revoked" },
      at
    )
    assert.deepEqual(missed, before)
  })

  test("AiSwitchConfirmed promotes the matching staged connection and clears staged", () => {
    const activeId = new Id<"AiConnection">("conn-active")
    const stagedId = new Id<"AiConnection">("conn-staged")
    const before: AiState = {
      ...initialAi,
      active: Just(connection({ connectionId: activeId })),
      staged: Just(connection({ connectionId: stagedId })),
    }

    const confirmed = applyAiEvent(
      before,
      { type: "AiSwitchConfirmed", aggregateId: workspaceId, connectionId: stagedId },
      at
    )
    assert.deepEqual(unwrap(confirmed.active), unwrap(before.staged))
    assert.equal(confirmed.staged instanceof Nothing, true)

    const unmatched = applyAiEvent(
      before,
      { type: "AiSwitchConfirmed", aggregateId: workspaceId, connectionId: new Id("unknown") },
      at
    )
    assert.deepEqual(unmatched, before)
  })

  test("AiSwitchDiscarded clears the matching staged connection and leaves active untouched", () => {
    const activeId = new Id<"AiConnection">("conn-active")
    const stagedId = new Id<"AiConnection">("conn-staged")
    const before: AiState = {
      ...initialAi,
      active: Just(connection({ connectionId: activeId })),
      staged: Just(connection({ connectionId: stagedId })),
    }

    const discarded = applyAiEvent(
      before,
      { type: "AiSwitchDiscarded", aggregateId: workspaceId, connectionId: stagedId },
      at
    )
    assert.equal(discarded.staged instanceof Nothing, true)
    assert.deepEqual(unwrap(discarded.active), unwrap(before.active))

    const unmatched = applyAiEvent(
      before,
      { type: "AiSwitchDiscarded", aggregateId: workspaceId, connectionId: new Id("unknown") },
      at
    )
    assert.deepEqual(unmatched, before)
  })

  test("AiConnectionDisconnected clears the matching active connection", () => {
    const activeId = new Id<"AiConnection">("conn-active")
    const before: AiState = { ...initialAi, active: Just(connection({ connectionId: activeId })) }

    const disconnected = applyAiEvent(
      before,
      { type: "AiConnectionDisconnected", aggregateId: workspaceId, connectionId: activeId },
      at
    )
    assert.equal(disconnected.active instanceof Nothing, true)

    const unmatched = applyAiEvent(
      before,
      { type: "AiConnectionDisconnected", aggregateId: workspaceId, connectionId: new Id("unknown") },
      at
    )
    assert.deepEqual(unmatched, before)
  })

  test("AiPreferencesChanged updates only the matching active connection's preferences", () => {
    const activeId = new Id<"AiConnection">("conn-active")
    const before: AiState = { ...initialAi, active: Just(connection({ connectionId: activeId })) }

    const changed = applyAiEvent(
      before,
      {
        type: "AiPreferencesChanged",
        aggregateId: workspaceId,
        connectionId: activeId,
        model: "test-b",
        effort: "low",
      },
      at
    )
    assert.deepEqual(unwrap(changed.active), {
      ...connection({ connectionId: activeId }),
      preferences: { model: "test-b", effort: "low" },
    })

    const unmatched = applyAiEvent(
      before,
      {
        type: "AiPreferencesChanged",
        aggregateId: workspaceId,
        connectionId: new Id("unknown"),
        model: "test-b",
        effort: "low",
      },
      at
    )
    assert.deepEqual(unmatched, before)
  })

  test("toSetupView never carries a credentialRef or accountId, by key or by value", () => {
    const state: AiState = {
      ...initialAi,
      active: Just(connection({ connectionId: new Id("conn-active") })),
      staged: Just(connection({ connectionId: new Id("conn-staged") })),
    }
    const json = JSON.stringify(toSetupView(state, routeViews("test")))
    assert.equal(json.includes("credentialRef"), false)
    assert.equal(json.includes("accountId"), false)
    assert.equal(json.includes("secret-1"), false)
    assert.equal(json.includes("hash-1"), false)
  })

  test("toSetupView drops the attemptId from lastAuthorization, and is null when there is none", () => {
    assert.equal(toSetupView(initialAi, routeViews("off")).lastAuthorization, null)

    const state: AiState = {
      ...initialAi,
      authorization: Just({
        attemptId: new Id("attempt-1"),
        provider: "xai",
        method: "device",
        purpose: "initial",
        expiresAt: at,
      }),
    }
    const view = toSetupView(state, routeViews("off"))
    assert.deepEqual(view.lastAuthorization, {
      provider: "xai",
      method: "device",
      purpose: "initial",
      expiresAt: at,
    })
    assert.equal(JSON.stringify(view).includes("attempt-1"), false)
  })

  test("routeViews live marks the API keys and xAI's device sign-in live, and the CLI-posing sign-ins unproven", () => {
    const availability = Object.fromEntries(
      routeViews("live").map(({ provider, method, availability }) => [`${provider}/${method}`, availability])
    )
    assert.deepEqual(availability, {
      "anthropic/setup_token": "unproven",
      "anthropic/api_key": "live",
      "xai/device": "live",
      "xai/api_key": "live",
    })
  })

  test("schema_AiState round-trips the initial state", () => {
    const decoded = s.decode(schema_AiState, s.encode(schema_AiState, initialAi))
    assert.equal(decoded instanceof Success, true)
    if (decoded instanceof Success) assert.deepEqual(decoded.value, initialAi)
  })

  test("schema_AiState round-trips a state with authorization, active and staged connections", () => {
    const state: AiState = {
      overviewCompleted: true,
      setupCompleted: false,
      authorization: Just({
        attemptId: new Id("attempt-1"),
        provider: "xai",
        method: "device",
        purpose: "initial",
        expiresAt: at,
      }),
      active: Just(connection({ connectionId: new Id("conn-active") })),
      staged: Just(connection({ connectionId: new Id("conn-staged"), status: "expired" })),
    }
    const decoded = s.decode(schema_AiState, s.encode(schema_AiState, state))
    assert.equal(decoded instanceof Success, true)
    if (decoded instanceof Success) assert.deepEqual(decoded.value, state)
  })
})
