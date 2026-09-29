import assert from "node:assert/strict"
import { describe, test, vi } from "vitest"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { Failure } from "@lib/result"
import { Id } from "@be/lib/event-sourcing/event"
import { Session } from "@be/app/session"
import { schemas } from "@be/app/events"
import { type UserActor } from "@be/app/actor"
import { type AiConnections } from "@be/app/ai/connections"

import { MemoryEventDatabase, MemorySessionStore, MemoryLoginCodes, memoryAi } from "@tests/support/memory"
import { result, rejection } from "@tests/support/future"

import { provisionUser } from "@be/domain/auth/provisionUser"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type Provider, type Method, type Purpose } from "@be/domain/ai/routes"
import { type Secret, type ProviderAdapter } from "@be/domain/ai/adapter"
import { FakeProvider, testAdapter } from "@tests/support/test-provider/adapter"

import { controller as startAuth } from "@be/domain/ai/command/startAuthorization"
import { controller as advanceAuth } from "@be/domain/ai/command/advanceAuthorization"
import { type StepRequest } from "@be/domain/ai/command/advanceAuthorization.api"
import { controller as cancelAuth } from "@be/domain/ai/command/cancelAuthorization"
import { controller as confirmSwitch } from "@be/domain/ai/command/confirmSwitch"
import { controller as discardSwitch } from "@be/domain/ai/command/discardSwitch"
import { controller as disconnectAi } from "@be/domain/ai/command/disconnect"
import { controller as setPreferences } from "@be/domain/ai/command/setPreferences"

let emailCounter = 0

/** A fresh, provisioned user and their (derived) workspace id — one per scenario, so connections never collide. */
async function freshWorkspace(db: MemoryEventDatabase): Promise<{ actor: UserActor; workspaceId: Id<"Workspace"> }> {
  const email = `user-${++emailCounter}@example.test`
  const userId = await provisionUser(db.withEventStore, email).promise((e) => new Error(JSON.stringify(e)))
  return { actor: { type: "User", userId }, workspaceId: Workspace.idForOwner(userId) }
}

function ctxFor(actor: UserActor, ai: AiConnections) {
  const sessions = new MemorySessionStore()
  return {
    actor,
    auth: { result: "allow" as const, actor },
    session: new Session(sessions, Nothing()),
    loginCodes: new MemoryLoginCodes(),
    ai,
  }
}
type Ctx = ReturnType<typeof ctxFor>

function start(
  db: MemoryEventDatabase,
  ctx: Ctx,
  route: { provider: Provider; method: Method },
  purpose: Purpose = "initial"
) {
  return result(startAuth.handler({ payload: { ...route, purpose }, withEventStore: db.withEventStore, ...ctx }))
}

function advance(db: MemoryEventDatabase, ctx: Ctx, attemptId: Id<"AiAttempt">, step: StepRequest) {
  return result(advanceAuth.handler({ payload: { attemptId, step }, withEventStore: db.withEventStore, ...ctx }))
}

function cancel(db: MemoryEventDatabase, ctx: Ctx, attemptId: Id<"AiAttempt">) {
  return result(cancelAuth.handler({ payload: { attemptId }, withEventStore: db.withEventStore, ...ctx }))
}

function expectFake(ai: AiConnections): FakeProvider {
  if (ai.fakeProvider instanceof Nothing) throw new Error("expected a fake provider")
  return ai.fakeProvider.value
}

/** Wraps a real `testAdapter` and defers one of its calls by a real macrotask, opening a genuine interleaving window. */
function withDelay(base: ProviderAdapter, which: "poll" | "verify"): ProviderAdapter {
  const delay = <T>(f: Future<Error, T>): Future<Error, T> =>
    Future.create<Error, T>((reject, resolve) => {
      const id = setTimeout(() => f.fork(reject, resolve), 0)
      return () => clearTimeout(id)
    })
  return which === "poll"
    ? { ...base, poll: (route, secret) => delay(base.poll(route, secret)) }
    : { ...base, verify: (route, credential) => delay(base.verify(route, credential)) }
}

/** Drives a full device flow to its terminal `advance` response, approving (or otherwise deciding) the user code along the way. */
async function connectDevice(
  db: MemoryEventDatabase,
  ctx: Ctx,
  ai: AiConnections,
  opts: { outcome?: "approve" | "approve_quota" | "deny" | "expire"; account?: string; purpose?: Purpose } = {}
) {
  const started = await start(db, ctx, { provider: "xai", method: "device" }, opts.purpose ?? "initial")
  if (started.status.status !== "pending") throw new Error("expected a pending device challenge")
  const challenge = started.status.challenge
  if (challenge.kind !== "device") throw new Error("expected a device challenge")
  const decided = expectFake(ai).decideDevice(
    challenge.userCode,
    opts.outcome ?? "approve",
    opts.account ?? "tester@example.test"
  )
  if (decided instanceof Failure) throw new Error(decided.error)
  const response = await advance(db, ctx, started.attemptId, { kind: "poll" })
  return { attemptId: started.attemptId, response }
}

/** Drives a full setup_token/api_key flow: `entered` becomes the credential itself (see `FakeProvider.accept` in `tests/support/test-provider/adapter.ts`). */
async function connectEntry(
  db: MemoryEventDatabase,
  ctx: Ctx,
  method: "setup_token" | "api_key",
  entered: string,
  provider: Provider,
  purpose: Purpose = "initial"
) {
  const started = await start(db, ctx, { provider, method }, purpose)
  const response = await advance(db, ctx, started.attemptId, { kind: "secret", secret: entered })
  return { attemptId: started.attemptId, response }
}

function hydrateWorkspace(db: MemoryEventDatabase, workspaceId: Id<"Workspace">): Workspace {
  const entries = db.entries.filter((e) => e.aggregate_id.value === workspaceId.value)
  return schemas.hydrate(Workspace, entries).unwrap((message) => message).aggregate
}

function secretString(secret: Secret): string {
  switch (secret.kind) {
    case "token":
      return secret.token
    case "key":
      return secret.key
    case "device":
      return secret.deviceCode
    case "oauth":
      return secret.accessToken
  }
}

type Captured = { refs: string[]; values: string[] }

/**
 * Every secret-shaped value still reachable for `attemptId`: its vault refs (which legitimately appear in an
 * event's `credentialRef` field — the architecture stores references, never secrets — so only responses are
 * checked against `refs`) and whatever those refs currently decrypt to (checked against both events and responses).
 */
async function secretsOf(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attemptId: Id<"AiAttempt">
): Promise<Captured> {
  const found = await ai.attempts.find(workspaceId, attemptId).promise((e) => e)
  if (found instanceof Nothing) return { refs: [], values: [] }
  const refs = [found.value.secretRef, found.value.credentialRef].flatMap((ref) =>
    ref instanceof Just ? [ref.value] : []
  )
  const values = await Promise.all(refs.map((ref) => ai.vault.get(workspaceId, ref).promise((e) => e)))
  return {
    refs: refs.map((ref) => ref.value),
    values: values.flatMap((v) => (v instanceof Just ? [secretString(v.value)] : [])),
  }
}

describe("AI connections", () => {
  test("no secret reaches an event or a response", async () => {
    const db = new MemoryEventDatabase()
    const responses: unknown[] = []
    const refs: string[] = []
    const values: string[] = []
    const capture = (c: Captured) => {
      refs.push(...c.refs)
      values.push(...c.values)
    }

    // Device: capture the device code before it's consumed by approval.
    {
      const { actor, workspaceId } = await freshWorkspace(db)
      const ai = memoryAi()
      const ctx = ctxFor(actor, ai)
      const started = await start(db, ctx, { provider: "xai", method: "device" })
      responses.push(started)
      capture(await secretsOf(ai, workspaceId, started.attemptId))
      const { response } = await connectDeviceFrom(db, ctx, ai, started)
      responses.push(response)
      assert.equal(response.status.status, "connected")
      capture(await secretsOf(ai, workspaceId, started.attemptId))
    }

    // setup_token / api_key: a literal we chose ourselves.
    for (const [method, provider, secretValue] of [
      ["setup_token", "anthropic", "shh-setup-token-value"],
      ["api_key", "xai", "shh-api-key-value"],
    ] as const) {
      const { actor, workspaceId } = await freshWorkspace(db)
      const ai = memoryAi()
      const ctx = ctxFor(actor, ai)
      values.push(secretValue)
      const { attemptId, response } = await connectEntry(db, ctx, method, secretValue, provider)
      responses.push(response)
      assert.equal(response.status.status, "connected")
      capture(await secretsOf(ai, workspaceId, attemptId))
    }

    const dbJson = JSON.stringify(db.entries)
    const responsesJson = JSON.stringify(responses)
    for (const value of new Set(values)) {
      assert.equal(dbJson.includes(value), false, `secret leaked into an event: ${value}`)
      assert.equal(responsesJson.includes(value), false, `secret leaked into a response: ${value}`)
    }
    for (const ref of new Set(refs)) {
      assert.equal(responsesJson.includes(ref), false, `vault ref leaked into a response: ${ref}`)
    }
  })

  test("an authorized credential never activates without a passing verify", async () => {
    const db = new MemoryEventDatabase()
    const { actor } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctx = ctxFor(actor, ai)

    const invalid = await connectEntry(db, ctx, "api_key", "invalid-key", "xai")
    assert.equal(invalid.response.status.status, "failed")
    if (invalid.response.status.status === "failed") assert.equal(invalid.response.status.reason, "invalid")
    assert.equal(invalid.response.setup.active, null)

    const quota = await connectDevice(db, ctx, ai, { outcome: "approve_quota" })
    assert.equal(quota.response.status.status, "failed")
    if (quota.response.status.status === "failed") assert.equal(quota.response.status.reason, "quota_exhausted")
    assert.equal(quota.response.setup.active, null)

    vi.useFakeTimers()
    try {
      const started = await start(db, ctx, { provider: "xai", method: "api_key" })
      const advancing = advance(db, ctx, started.attemptId, { kind: "secret", secret: "slow-key" })
      await vi.advanceTimersByTimeAsync(20_000)
      const advanced = await advancing
      assert.equal(advanced.status.status, "failed")
      if (advanced.status.status === "failed") assert.equal(advanced.status.reason, "unreachable")
      assert.equal(advanced.setup.active, null)
    } finally {
      vi.useRealTimers()
    }
  })

  test("a switch stays staged until confirmed; discard keeps the old connection, confirm swaps it", async () => {
    const db = new MemoryEventDatabase()
    const { actor, workspaceId } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctx = ctxFor(actor, ai)

    const first = await connectDevice(db, ctx, ai, { account: "first@example.test" })
    const activeBefore = first.response.setup.active
    assert.ok(activeBefore)

    const staged = await connectEntry(db, ctx, "api_key", "staged-key-one", "xai", "switch")
    assert.equal(staged.response.status.status, "connected")
    if (staged.response.status.status === "connected") assert.equal(staged.response.status.role, "staged")
    assert.deepEqual(staged.response.setup.active, activeBefore)
    const stagedView = staged.response.setup.staged
    assert.ok(stagedView)

    const wsBeforeDiscard = hydrateWorkspace(db, workspaceId)
    if (!(wsBeforeDiscard.values.ai.staged instanceof Just)) throw new Error("expected a staged connection")
    const stagedRef = wsBeforeDiscard.values.ai.staged.value.credentialRef

    const discarded = await result(
      discardSwitch.handler({
        payload: { connectionId: stagedView.connectionId },
        withEventStore: db.withEventStore,
        ...ctx,
      })
    )
    assert.deepEqual(discarded.setup.active, activeBefore)
    assert.equal(discarded.setup.staged, null)
    assert.ok((await ai.vault.get(workspaceId, stagedRef).promise((e) => e)) instanceof Nothing)

    const staged2 = await connectEntry(db, ctx, "api_key", "staged-key-two", "xai", "switch")
    const stagedView2 = staged2.response.setup.staged
    assert.ok(stagedView2)

    const wsBeforeConfirm = hydrateWorkspace(db, workspaceId)
    if (!(wsBeforeConfirm.values.ai.active instanceof Just)) throw new Error("expected an active connection")
    const oldActiveRef = wsBeforeConfirm.values.ai.active.value.credentialRef

    const confirmed = await result(
      confirmSwitch.handler({
        payload: { connectionId: stagedView2.connectionId },
        withEventStore: db.withEventStore,
        ...ctx,
      })
    )
    assert.equal(confirmed.setup.active?.connectionId.value, stagedView2.connectionId.value)
    assert.equal(confirmed.setup.staged, null)
    assert.ok((await ai.vault.get(workspaceId, oldActiveRef).promise((e) => e)) instanceof Nothing)
  })

  test("cancel leaves the active connection untouched: before authorization, mid-verify, and after a verification failure", async () => {
    const db = new MemoryEventDatabase()
    const { actor } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctx = ctxFor(actor, ai)

    const first = await connectDevice(db, ctx, ai)
    const activeBefore = first.response.setup.active
    assert.ok(activeBefore)

    const beforeAuth = await start(db, ctx, { provider: "xai", method: "device" }, "switch")
    const cancelledBeforeAuth = await cancel(db, ctx, beforeAuth.attemptId)
    assert.deepEqual(cancelledBeforeAuth.setup.active, activeBefore)

    const failedAuth = await start(db, ctx, { provider: "xai", method: "api_key" }, "switch")
    const failedAdvance = await advance(db, ctx, failedAuth.attemptId, { kind: "secret", secret: "invalid-key" })
    assert.equal(failedAdvance.status.status, "failed")
    const cancelledAfterFailure = await cancel(db, ctx, failedAuth.attemptId)
    assert.deepEqual(cancelledAfterFailure.setup.active, activeBefore)

    const fake = expectFake(ai)
    const delayedAi: AiConnections = { ...ai, adapter: () => Just(withDelay(testAdapter(fake), "verify")) }
    const ctxDelayed = ctxFor(actor, delayedAi)
    const midVerify = await start(db, ctxDelayed, { provider: "xai", method: "api_key" }, "switch")
    const advancing = advance(db, ctxDelayed, midVerify.attemptId, { kind: "secret", secret: "mid-verify-key" })
    const cancelledMidVerify = await cancel(db, ctx, midVerify.attemptId)
    assert.deepEqual(cancelledMidVerify.setup.active, activeBefore)
    const lateResult = await advancing
    assert.equal(lateResult.status.status, "failed")
    if (lateResult.status.status === "failed") assert.equal(lateResult.status.reason, "cancelled")
    assert.deepEqual(lateResult.setup.active, activeBefore)
  })

  test("a late result from a superseded attempt is ignored", async () => {
    const db = new MemoryEventDatabase()
    const { actor } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctx = ctxFor(actor, ai)

    const fake = expectFake(ai)
    const delayedAi: AiConnections = { ...ai, adapter: () => Just(withDelay(testAdapter(fake), "verify")) }
    const ctxDelayed = ctxFor(actor, delayedAi)

    const first = await start(db, ctxDelayed, { provider: "xai", method: "api_key" })
    const advancing = advance(db, ctxDelayed, first.attemptId, { kind: "secret", secret: "late-key" })

    const restarted = await start(db, ctx, { provider: "xai", method: "device" })

    const late = await advancing
    assert.equal(late.status.status, "failed")
    if (late.status.status === "failed") assert.equal(late.status.reason, "superseded")
    assert.equal(late.setup.active, null)

    const { response } = await connectDeviceFrom(db, ctx, ai, restarted)
    assert.equal(response.status.status, "connected")
  })

  test("two concurrent polls for the same approved device attempt emit exactly one AiConnectionVerified", async () => {
    const db = new MemoryEventDatabase()
    const { actor } = await freshWorkspace(db)
    const ai = memoryAi()
    const fake = expectFake(ai)
    const delayedAi: AiConnections = { ...ai, adapter: () => Just(withDelay(testAdapter(fake), "poll")) }
    const ctx = ctxFor(actor, delayedAi)

    const started = await start(db, ctx, { provider: "xai", method: "device" })
    if (started.status.status !== "pending" || started.status.challenge.kind !== "device") {
      throw new Error("expected a device challenge")
    }
    const decided = fake.decideDevice(started.status.challenge.userCode, "approve", "tester@example.test")
    if (decided instanceof Failure) throw new Error(decided.error)

    const [first, second] = await Promise.all([
      advance(db, ctx, started.attemptId, { kind: "poll" }),
      advance(db, ctx, started.attemptId, { kind: "poll" }),
    ])
    const statuses = [first.status.status, second.status.status].sort()
    assert.deepEqual(statuses, ["connected", "pending"])
    assert.equal(db.entries.filter((e) => e.event_name === "AiConnectionVerified").length, 1)
  })

  test("another workspace cannot advance, cancel, or read another user's attempt", async () => {
    const db = new MemoryEventDatabase()
    const { actor: actorA, workspaceId: workspaceA } = await freshWorkspace(db)
    const { actor: actorB } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctxA = ctxFor(actorA, ai)
    const ctxB = ctxFor(actorB, ai)

    const started = await start(db, ctxA, { provider: "xai", method: "device" })

    const advanceRejection = await rejection(
      advanceAuth.handler({
        payload: { attemptId: started.attemptId, step: { kind: "poll" } },
        withEventStore: db.withEventStore,
        ...ctxB,
      })
    )
    assert.match(JSON.stringify(advanceRejection), /404/)

    const cancelRejection = await rejection(
      cancelAuth.handler({ payload: { attemptId: started.attemptId }, withEventStore: db.withEventStore, ...ctxB })
    )
    assert.match(JSON.stringify(cancelRejection), /404/)

    const attemptRow = await ai.attempts.find(workspaceA, started.attemptId).promise((e) => e)
    if (!(attemptRow instanceof Just) || !(attemptRow.value.secretRef instanceof Just)) {
      throw new Error("expected a device secret ref")
    }
    const ref = attemptRow.value.secretRef.value
    const workspaceB = Workspace.idForOwner(actorB.userId)
    assert.ok((await ai.vault.get(workspaceB, ref).promise((e) => e)) instanceof Nothing)
    assert.ok((await ai.vault.get(workspaceA, ref).promise((e) => e)) instanceof Just)
  })

  test("preferences outside verified capabilities are rejected and nothing is emitted", async () => {
    const db = new MemoryEventDatabase()
    const { actor } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctx = ctxFor(actor, ai)
    const connected = await connectDevice(db, ctx, ai)
    const active = connected.response.setup.active
    assert.ok(active)
    const before = db.entries.length

    const unusable = await rejection(
      setPreferences.handler({
        payload: { connectionId: active.connectionId, model: "test-d", effort: "low" },
        withEventStore: db.withEventStore,
        ...ctx,
      })
    )
    assert.match(JSON.stringify(unusable), /422/)

    const unsupportedEffort = await rejection(
      setPreferences.handler({
        payload: { connectionId: active.connectionId, model: "test-c", effort: "low" },
        withEventStore: db.withEventStore,
        ...ctx,
      })
    )
    assert.match(JSON.stringify(unsupportedEffort), /422/)
    assert.equal(db.entries.length, before)
  })

  test("disconnect deletes the secret and clears active", async () => {
    const db = new MemoryEventDatabase()
    const { actor, workspaceId } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctx = ctxFor(actor, ai)
    const connected = await connectDevice(db, ctx, ai)
    const active = connected.response.setup.active
    assert.ok(active)

    const ws = hydrateWorkspace(db, workspaceId)
    if (!(ws.values.ai.active instanceof Just)) throw new Error("expected an active connection")
    const ref = ws.values.ai.active.value.credentialRef

    const disconnected = await result(
      disconnectAi.handler({
        payload: { connectionId: active.connectionId },
        withEventStore: db.withEventStore,
        ...ctx,
      })
    )
    assert.equal(disconnected.setup.active, null)
    assert.ok((await ai.vault.get(workspaceId, ref).promise((e) => e)) instanceof Nothing)
  })

  test("reconnecting with a different account is rejected and the active connection is unchanged", async () => {
    const db = new MemoryEventDatabase()
    const { actor } = await freshWorkspace(db)
    const ai = memoryAi()
    const ctx = ctxFor(actor, ai)
    const connected = await connectEntry(db, ctx, "setup_token", "first-account-token", "anthropic")
    assert.equal(connected.response.status.status, "connected")
    const activeBefore = connected.response.setup.active

    const started = await start(db, ctx, { provider: "anthropic", method: "setup_token" }, "reconnect")
    const advanced = await advance(db, ctx, started.attemptId, { kind: "secret", secret: "other-account-token" })
    assert.equal(advanced.status.status, "failed")
    if (advanced.status.status === "failed") assert.equal(advanced.status.reason, "different_account")
    assert.deepEqual(advanced.setup.active, activeBefore)
  })
})

/** Continues a device flow from an already-`started` attempt (used when the challenge was captured before approving). */
async function connectDeviceFrom(
  db: MemoryEventDatabase,
  ctx: Ctx,
  ai: AiConnections,
  started: Awaited<ReturnType<typeof start>>
) {
  if (started.status.status !== "pending" || started.status.challenge.kind !== "device") {
    throw new Error("expected a pending device challenge")
  }
  const decided = expectFake(ai).decideDevice(started.status.challenge.userCode, "approve", "tester@example.test")
  if (decided instanceof Failure) throw new Error(decided.error)
  const response = await advance(db, ctx, started.attemptId, { kind: "poll" })
  return { response }
}
