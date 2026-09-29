import assert from "node:assert/strict"
import { afterEach, describe, test, vi } from "vitest"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"
import { Session } from "@be/app/session"
import { schemas } from "@be/app/events"
import { type UserActor } from "@be/app/actor"

import { MemoryEventDatabase, MemorySessionStore, MemoryLoginCodes, MemoryVault, memoryAi } from "@tests/support/memory"
import { result, rejection } from "@tests/support/future"

import { provisionUser } from "@be/domain/auth/provisionUser"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type Secret, type Readiness, type ProviderAdapter, CredentialRevoked } from "@be/domain/ai/adapter"
import { FakeProvider, testAdapter } from "@tests/support/test-provider/adapter"
import { AiConnectionChecked } from "@be/domain/workspace/events/workspace/aiConnectionChecked"

import { controller as startAuth } from "@be/domain/ai/command/startAuthorization"
import { controller as advanceAuth } from "@be/domain/ai/command/advanceAuthorization"
import { controller as testConnection } from "@be/domain/ai/command/testConnection"

const APP = "http://localhost:5173/jobs/"
/** A sign-in's tokens last 10 minutes, and the adapter renews them once fewer than 5 are left (xAI's own buffer). */
const FIRST_LIFETIME = Duration.minutes(10)
const RENEWED_LIFETIME = Duration.hours(1)
const REFRESH_WINDOW = Duration.minutes(5)

const READY: Readiness = {
  kind: "ready",
  accountId: "account-1",
  capabilities: {
    account: "t•••@example.test",
    billing: "Your xAI account",
    models: [{ id: "grok-a", summary: "", recommended: true, efforts: ["low"], usable: true, reason: null }],
  },
}

/** Resolves on a later macrotask, so overlapping calls really interleave. */
const pause = <T>(value: T, ms = 0): Future<Error, T> =>
  Future.create<Error, T>((_, resolve) => {
    const timer = setTimeout(() => resolve(value), ms)
    return () => clearTimeout(timer)
  })

/**
 * xAI's shape over the test adapter's `begin`: `poll` authorizes a 10-minute sign-in; `refresh` swaps one inside its
 * last 5 minutes for a new pair and refuses a refresh token that was already spent, as a rotating provider does;
 * `verify` notes which token it was shown (a lapsed one never reaches it: `resolveCredential` settles it first).
 */
function rotatingAdapter(fake: FakeProvider) {
  const seen = {
    rotations: 0,
    verified: [] as string[],
    refreshFails: false,
    refreshRevoked: false,
    verifyFailsOnce: false,
  }
  const spent = new Set<string>()
  const tokens = (n: number, lifetime: Duration): Secret => ({
    kind: "oauth",
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: POSIX.now().addDuration(lifetime),
  })
  const adapter: ProviderAdapter = {
    ...testAdapter(fake),
    poll: () => Future.resolve({ kind: "authorized", credential: tokens(0, FIRST_LIFETIME) }),
    verify: (_route, credential) => {
      if (credential.kind !== "oauth") return Future.resolve({ kind: "failed", reason: "invalid" })
      seen.verified.push(credential.accessToken)
      if (seen.verifyFailsOnce) {
        seen.verifyFailsOnce = false
        return Future.resolve<Error, Readiness>({ kind: "failed", reason: "unreachable" })
      }
      // Staggered per call, so two overlapping checks never write to the workspace at the same instant.
      return pause<Readiness>(READY, 5 * seen.verified.length)
    },
    refresh: (_route, credential) => {
      if (credential.kind !== "oauth" || credential.expiresAt.isAfter(POSIX.now().addDuration(REFRESH_WINDOW)))
        return Future.resolve(credential)
      if (seen.refreshFails) return Future.reject(new Error("xAI token refresh failed (500)"))
      if (seen.refreshRevoked || spent.has(credential.refreshToken))
        return Future.reject(new CredentialRevoked("xAI tokens have been revoked"))
      spent.add(credential.refreshToken)
      seen.rotations++
      return pause(tokens(seen.rotations, RENEWED_LIFETIME))
    },
  }
  return { adapter, seen, tokens }
}

let emailCounter = 0

async function scenario() {
  vi.useFakeTimers({ toFake: ["Date"] })
  const db = new MemoryEventDatabase()
  const fake = new FakeProvider(APP)
  const rotating = rotatingAdapter(fake)
  const ai = memoryAi({ fake, adapter: rotating.adapter })
  const userId = await provisionUser(db.withEventStore, `refresh-${++emailCounter}@example.test`).promise(
    (e) => new Error(JSON.stringify(e))
  )
  const actor: UserActor = { type: "User", userId }
  const workspaceId = Workspace.idForOwner(userId)
  const ctx = {
    actor,
    auth: { result: "allow" as const, actor },
    session: new Session(new MemorySessionStore(), Nothing()),
    loginCodes: new MemoryLoginCodes(),
    ai,
    withEventStore: db.withEventStore,
  }

  const activeConnection = () => {
    const stream = db.entries.filter((e) => e.aggregate_id.value === workspaceId.value)
    const { active } = schemas.hydrate(Workspace, stream).unwrap((message) => message).aggregate.values.ai
    if (!(active instanceof Just)) throw new Error("expected an active connection")
    return active.value
  }
  const connect = async (): Promise<Id<"AiConnection">> => {
    const started = await result(
      startAuth.handler({ ...ctx, payload: { provider: "xai", method: "device", purpose: "initial" } })
    )
    const connected = await result(
      advanceAuth.handler({ ...ctx, payload: { attemptId: started.attemptId, step: { kind: "poll" } } })
    )
    assert.deepEqual(connected.status, { status: "connected", role: "active" })
    return activeConnection().connectionId
  }
  const check = (connectionId: Id<"AiConnection">) =>
    result(testConnection.handler({ ...ctx, payload: { connectionId } }))
  const stored = (ref: Id<"AiSecret">) => ai.vault.get(workspaceId, ref).promise((e) => e)
  const vaultRefs = (): string[] => {
    if (!(ai.vault instanceof MemoryVault)) throw new Error("expected the memory vault")
    return ai.vault.refsFor(workspaceId)
  }
  const recordedChecks = (): number => db.entries.filter((e) => e.event_name === AiConnectionChecked.type).length
  const advanceClock = (by: Duration): void => {
    vi.setSystemTime(Date.now() + by.asMilliseconds())
  }

  return {
    ...rotating,
    ctx,
    ai,
    workspaceId,
    connect,
    check,
    stored,
    vaultRefs,
    recordedChecks,
    activeConnection,
    advanceClock,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("AI credential refresh", () => {
  test("Test connection refreshes an expiring sign-in and re-seals it under the same ref", async () => {
    const s = await scenario()
    const connectionId = await s.connect()
    const ref = s.activeConnection().credentialRef
    assert.deepEqual(await s.stored(ref), Just(s.tokens(0, FIRST_LIFETIME)))
    // Connecting verified a sign-in with time left: nothing was rotated.
    assert.equal(s.seen.rotations, 0)
    assert.equal(s.recordedChecks(), 0)

    // 4 minutes left: inside the refresh window.
    s.advanceClock(Duration.minutes(6))
    const checked = await s.check(connectionId)

    assert.equal(checked.setup.active?.status, "ready")
    assert.equal(s.seen.rotations, 1)
    // verify saw the renewed access token, and the vault holds the new pair under the very same ref.
    assert.equal(s.seen.verified.at(-1), "access-1")
    assert.equal(s.activeConnection().credentialRef.value, ref.value)
    assert.deepEqual(await s.stored(ref), Just(s.tokens(1, RENEWED_LIFETIME)))
    assert.deepEqual(s.vaultRefs(), [ref.value])
    assert.equal(s.recordedChecks(), 1)
    assert.equal(s.activeConnection().status, "ready")

    // The renewed tokens have an hour left: the next check leaves them alone.
    await s.check(connectionId)
    assert.equal(s.seen.rotations, 1)
    assert.deepEqual(await s.stored(ref), Just(s.tokens(1, RENEWED_LIFETIME)))
    assert.equal(s.recordedChecks(), 2)
  })

  test("A refresh that fails in passing keeps the credential: verified while it lasts, unreachable once lapsed", async () => {
    const s = await scenario()
    const connectionId = await s.connect()
    const ref = s.activeConnection().credentialRef
    const before = await s.stored(ref)
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    s.seen.refreshFails = true

    s.advanceClock(Duration.minutes(6))
    const stillValid = await s.check(connectionId)

    // The access token has minutes left, so verify still vouches for it.
    assert.equal(stillValid.setup.active?.status, "ready")
    assert.equal(s.seen.verified.at(-1), "access-0")
    assert.deepEqual(await s.stored(ref), before)

    // Once it has lapsed, xAI couldn't renew it: "unreachable" (retryable), not "revoked", and not a 500. verify isn't asked.
    const verifiedBefore = s.seen.verified.length
    s.advanceClock(Duration.minutes(5))
    const lapsed = await s.check(connectionId)

    assert.equal(lapsed.setup.active?.status, "unreachable")
    assert.equal(s.seen.verified.length, verifiedBefore)
    assert.deepEqual(await s.stored(ref), before)
    assert.equal(s.activeConnection().credentialRef.value, ref.value)
    assert.equal(s.recordedChecks(), 2)
    // Only the error's class reaches the log, not the provider's message.
    const lines = logged.mock.calls.map((args) => args.map(String).join(" "))
    assert.deepEqual(lines, [
      "AI adapter refresh failed for xai/device: Error",
      "AI adapter refresh failed for xai/device: Error",
    ])
  })

  test("A refresh token the provider revoked reports revoked without asking verify", async () => {
    const s = await scenario()
    const connectionId = await s.connect()
    const ref = s.activeConnection().credentialRef
    const before = await s.stored(ref)
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    s.seen.refreshRevoked = true
    const verifiedBefore = s.seen.verified.length

    s.advanceClock(Duration.minutes(6))
    const revoked = await s.check(connectionId)

    assert.equal(revoked.setup.active?.status, "revoked")
    assert.equal(s.seen.verified.length, verifiedBefore)
    assert.deepEqual(await s.stored(ref), before)
    const lines = logged.mock.calls.map((args) => args.map(String).join(" "))
    assert.deepEqual(lines, ["AI adapter refresh failed for xai/device: CredentialRevoked"])
  })

  test("A vault failure while re-sealing is a 500, not a refresh verdict", async () => {
    const s = await scenario()
    const connectionId = await s.connect()
    if (!(s.ai.vault instanceof MemoryVault)) throw new Error("expected the memory vault")
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(s.ai.vault, "update").mockReturnValue(Future.reject(new Error("db down")))

    s.advanceClock(Duration.minutes(6))
    const failed = await rejection(testConnection.handler({ ...s.ctx, payload: { connectionId } }))

    assert.match(JSON.stringify(failed), /"status":500/)
    assert.equal(s.recordedChecks(), 0)
    const lines = logged.mock.calls.map((args) => args.map(String).join(" "))
    assert.ok(!lines.some((line) => line.includes("refresh failed")), lines.join("\n"))
  })

  test("A sign-in retry whose lapsed token can't be renewed reports unreachable, then connects once it can", async () => {
    const s = await scenario()
    s.seen.verifyFailsOnce = true
    const started = await result(
      startAuth.handler({ ...s.ctx, payload: { provider: "xai", method: "device", purpose: "initial" } })
    )
    const first = await result(
      advanceAuth.handler({ ...s.ctx, payload: { attemptId: started.attemptId, step: { kind: "poll" } } })
    )
    assert.deepEqual(first.status, { status: "failed", reason: "unreachable", retry: "verify" })
    assert.equal(s.seen.verified.length, 1)
    vi.spyOn(console, "error").mockImplementation(() => undefined)

    // 11 minutes later the 10-minute token has lapsed, and xAI can't renew it right now.
    s.advanceClock(Duration.minutes(11))
    s.seen.refreshFails = true
    const retried = await result(
      advanceAuth.handler({ ...s.ctx, payload: { attemptId: started.attemptId, step: { kind: "retry" } } })
    )
    assert.deepEqual(retried.status, { status: "failed", reason: "unreachable", retry: "verify" })
    assert.equal(s.seen.verified.length, 1)

    s.seen.refreshFails = false
    const connected = await result(
      advanceAuth.handler({ ...s.ctx, payload: { attemptId: started.attemptId, step: { kind: "retry" } } })
    )
    assert.deepEqual(connected.status, { status: "connected", role: "active" })
    assert.equal(s.seen.rotations, 1)
    assert.equal(s.seen.verified.at(-1), "access-1")
  })

  test("Two overlapping checks refresh once", async () => {
    const s = await scenario()
    const connectionId = await s.connect()
    const ref = s.activeConnection().credentialRef
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)

    s.advanceClock(Duration.minutes(6))
    const [first, second] = await Promise.all([s.check(connectionId), s.check(connectionId)])

    assert.equal(first.setup.active?.status, "ready")
    assert.equal(second.setup.active?.status, "ready")
    // One rotation spent the refresh token; the second check waited for it and found the renewed pair, so it was
    // neither refused a spent token (a logged failure) nor shown the stale access token.
    assert.equal(s.seen.rotations, 1)
    assert.deepEqual(s.seen.verified.slice(-2), ["access-1", "access-1"])
    assert.deepEqual(logged.mock.calls, [])
    assert.deepEqual(await s.stored(ref), Just(s.tokens(1, RENEWED_LIFETIME)))
    assert.equal(s.recordedChecks(), 2)
  })
})
