import assert from "node:assert/strict"
import { afterEach, describe, test, vi } from "vitest"

import OpenAI from "openai"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"
import { Session } from "@be/app/session"
import { schemas } from "@be/app/events"
import { type UserActor } from "@be/app/actor"
import { type AiConnections } from "@be/app/ai/connections"
import { type Attempts } from "@be/app/ai/attempts"
import { type SecretVault } from "@be/app/ai/vault"

import { MemoryEventDatabase, MemorySessionStore, MemoryLoginCodes, MemoryVault, memoryAi } from "@tests/support/memory"
import { result, rejection } from "@tests/support/future"

import { provisionUser } from "@be/domain/auth/provisionUser"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type Method, type Provider, type Purpose } from "@be/domain/ai/routes"
import { type ProviderAdapter } from "@be/domain/ai/adapter"
import { FakeProvider, testAdapter } from "@be/app/ai/testAdapter"
import { apiKeyAdapter } from "@be/app/ai/apiKeyAdapter"
import { type Llm } from "@be/app/ai/llm/router"
import { type StepRequest } from "@be/domain/ai/command/advanceAuthorization.api"

import { controller as startAuth } from "@be/domain/ai/command/startAuthorization"
import { controller as advanceAuth } from "@be/domain/ai/command/advanceAuthorization"
import { controller as cancelAuth } from "@be/domain/ai/command/cancelAuthorization"
import { controller as confirmSwitch } from "@be/domain/ai/command/confirmSwitch"
import { controller as discardSwitch } from "@be/domain/ai/command/discardSwitch"
import { controller as disconnect } from "@be/domain/ai/command/disconnect"
import { controller as setPreferences } from "@be/domain/ai/command/setPreferences"
import { controller as testConnection } from "@be/domain/ai/command/testConnection"

const APP = "http://localhost:5173/jobs/"
let emailCounter = 0

async function scenario(options: { fake?: FakeProvider; adapter?: ProviderAdapter } = {}) {
  const db = new MemoryEventDatabase()
  const fake = options.fake ?? new FakeProvider(APP)
  const ai: AiConnections = memoryAi({ fake, ...(options.adapter === undefined ? {} : { adapter: options.adapter }) })
  const userId = await provisionUser(db.withEventStore, `recovery-${++emailCounter}@example.test`).promise(
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
  const start = (provider: Provider, method: Method, purpose: Purpose = "initial") =>
    startAuth.handler({ ...ctx, payload: { provider, method, purpose } })
  const advance = (attemptId: Id<"AiAttempt">, step: StepRequest) =>
    advanceAuth.handler({ ...ctx, payload: { attemptId, step } })
  const connectKey = async (key: string, purpose: Purpose = "initial", provider: Provider = "openai") => {
    const started = await result(start(provider, "api_key", purpose))
    return result(advance(started.attemptId, { kind: "secret", secret: key }))
  }
  /** The refs the registry points at: active and staged credentials. */
  const referenced = (): string[] => {
    const stream = db.entries.filter((e) => e.aggregate_id.value === workspaceId.value)
    const ai = schemas.hydrate(Workspace, stream).unwrap((message) => message).aggregate.values.ai
    return [ai.active, ai.staged].flatMap((c) => (c instanceof Just ? [c.value.credentialRef.value] : []))
  }
  const vaultRefs = (): string[] => {
    if (!(ai.vault instanceof MemoryVault)) throw new Error("expected the memory vault")
    return ai.vault.refsFor(workspaceId)
  }
  return { db, fake, ai, ctx, workspaceId, start, advance, connectKey, referenced, vaultRefs }
}

const statusOf = (response: unknown): string => JSON.stringify(response)
const sorted = (xs: string[]): string[] => [...xs].sort()

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("AI recovery", () => {
  test("a failed device verify stays failed through repeated polls until the user retries", async () => {
    const s = await scenario()
    const started = await result(s.start("openai", "device"))
    if (started.status.status !== "pending" || started.status.challenge.kind !== "device") throw new Error("device")
    s.fake.decideDevice(started.status.challenge.userCode, "approve_quota", "tester@example.test")

    const failed = await result(s.advance(started.attemptId, { kind: "poll" }))
    assert.deepEqual(failed.status, { status: "failed", reason: "quota_exhausted", retry: "verify" })

    // Repeated polling must not reset the failure to pending, or store a second copy of the credential.
    assert.deepEqual((await result(s.advance(started.attemptId, { kind: "poll" }))).status, failed.status)
    assert.equal(s.vaultRefs().length, 1)

    const grant = s.fake.grants().find((g) => g.method === "device")
    assert.ok(grant)
    s.fake.setGrant(grant.id, "ok")
    const retried = await result(s.advance(started.attemptId, { kind: "retry" }))
    assert.deepEqual(retried.status, { status: "connected", role: "active" })
    assert.deepEqual(sorted(s.vaultRefs()), sorted(s.referenced()))
  })

  test("a device quota failure is not turned into an expired code by the next poll", async () => {
    const s = await scenario()
    const started = await result(s.start("openai", "device"))
    if (started.status.status !== "pending" || started.status.challenge.kind !== "device") throw new Error("device")
    s.fake.decideDevice(started.status.challenge.userCode, "approve_quota", "tester@example.test")

    const failed = await result(s.advance(started.attemptId, { kind: "poll" }))
    assert.deepEqual(failed.status, { status: "failed", reason: "quota_exhausted", retry: "verify" })
    assert.deepEqual((await result(s.advance(started.attemptId, { kind: "poll" }))).status, failed.status)
  })

  test("denied and time-expired device attempts drop their sealed device code", async () => {
    const denied = await scenario()
    const d = await result(denied.start("openai", "device"))
    if (d.status.status !== "pending" || d.status.challenge.kind !== "device") throw new Error("device")
    denied.fake.decideDevice(d.status.challenge.userCode, "deny", "tester@example.test")
    assert.equal((await result(denied.advance(d.attemptId, { kind: "poll" }))).status.status, "failed")
    assert.deepEqual(denied.vaultRefs(), [])

    const expired = await scenario()
    vi.useFakeTimers({ toFake: ["Date"] })
    const e = await result(expired.start("xai", "device"))
    assert.equal(expired.vaultRefs().length, 1)
    vi.setSystemTime(Date.now() + 16 * 60 * 1000)
    const polled = await result(expired.advance(e.attemptId, { kind: "poll" }))
    assert.deepEqual(polled.status, { status: "failed", reason: "expired", retry: "restart" })
    assert.deepEqual(expired.vaultRefs(), [])
  })

  test("a verify that rejects reads as unreachable, keeps the credential for retry, frees the attempt and logs no secret", async () => {
    const fake = new FakeProvider(APP)
    const base = testAdapter(fake)
    let rejectVerify = false
    const adapter: ProviderAdapter = {
      ...base,
      verify: (route, credential) =>
        rejectVerify ? Future.reject(new Error("upstream said: sk-leaky-key is bad")) : base.verify(route, credential),
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const s = await scenario({ fake, adapter })

    const connected = await s.connectKey("sk-leaky-key")
    const active = connected.setup.active
    assert.ok(active)

    rejectVerify = true
    const checked = await result(testConnection.handler({ ...s.ctx, payload: { connectionId: active.connectionId } }))
    assert.equal(checked.setup.active?.status, "unreachable")

    const started = await result(s.start("xai", "api_key", "switch"))
    const failed = await result(s.advance(started.attemptId, { kind: "secret", secret: "sk-leaky-switch" }))
    assert.deepEqual(failed.status, { status: "failed", reason: "unreachable", retry: "verify" })
    // The lease was released: an immediate retry runs again instead of being answered "pending".
    assert.deepEqual((await result(s.advance(started.attemptId, { kind: "retry" }))).status, failed.status)
    rejectVerify = false
    const retried = await result(s.advance(started.attemptId, { kind: "retry" }))
    assert.deepEqual(retried.status, { status: "connected", role: "staged" })

    const lines = logged.mock.calls.map((args) => args.map(String).join(" "))
    assert.ok(lines.length > 0)
    for (const line of lines) {
      assert.equal(line.includes("sk-leaky"), false, `secret in log: ${line}`)
    }
  })

  test("an adapter call that rejects frees the attempt at once", async () => {
    const base = testAdapter(new FakeProvider(APP))
    const adapter: ProviderAdapter = { ...base, accept: () => Future.reject(new Error("exchange failed")) }
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const s = await scenario({ adapter })
    const started = await result(s.start("openai", "api_key"))
    const step: StepRequest = { kind: "secret", secret: "sk-any" }

    assert.match(statusOf(await rejection(s.advance(started.attemptId, step))), /"status":500/)
    // Still claimable: without the release this second call would be answered "pending" for 30 s.
    assert.match(statusOf(await rejection(s.advance(started.attemptId, step))), /"status":500/)
  })

  test("confirm refuses a staged connection that stopped passing its check and keeps the working one", async () => {
    const s = await scenario()
    const active = (await s.connectKey("sk-working")).setup.active
    assert.ok(active)
    const staged = (await s.connectKey("sk-staged-then-revoked", "switch", "xai")).setup.staged
    assert.ok(staged)
    const stagedGrant = s.fake.grants().find((g) => g.provider === "xai")
    assert.ok(stagedGrant)
    s.fake.setGrant(stagedGrant.id, "revoked")
    await result(testConnection.handler({ ...s.ctx, payload: { connectionId: staged.connectionId } }))

    const refused = await rejection(confirmSwitch.handler({ ...s.ctx, payload: { connectionId: staged.connectionId } }))
    assert.match(statusOf(refused), /"status":409/)
    const refs = s.referenced()
    assert.equal(refs.length, 2)
    assert.deepEqual(sorted(s.vaultRefs()), sorted(refs))
  })

  test("an API-key reconnect replaces a revoked key with a new one", async () => {
    const revoked = new Set<string>()
    const answer = <T>(key: string, value: T): Future<Error, T> =>
      revoked.has(key)
        ? Future.reject(OpenAI.APIError.generate(401, {}, "Incorrect API key provided", new Headers()))
        : Future.resolve(value)
    const llm: Llm = {
      listModels: (_provider, key) =>
        answer(key, [
          { id: "model-a", name: "Model A", createdAt: POSIX.now(), structuredOutput: Nothing(), efforts: Nothing() },
        ]),
      generate: (provider, key) =>
        answer(key, {
          text: "OK",
          metadata: {
            provider,
            model: "model-a",
            effort: Just("low"),
            duration: Duration.milliseconds(5),
            tokens: Nothing(),
          },
        }),
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const s = await scenario({ adapter: apiKeyAdapter(llm, "account-key") })
    const firstKey = `sk-${"a".repeat(20)}1111`
    const active = (await s.connectKey(firstKey)).setup.active
    assert.ok(active)
    revoked.add(firstKey)
    const checked = await result(testConnection.handler({ ...s.ctx, payload: { connectionId: active.connectionId } }))
    assert.notEqual(checked.setup.active?.status, "ready")

    const reconnected = await s.connectKey(`sk-${"b".repeat(20)}2222`, "reconnect")
    assert.deepEqual(reconnected.status, { status: "connected", role: "active" })
    assert.equal(reconnected.setup.active?.connectionId.value, active.connectionId.value)
    assert.equal(reconnected.setup.active?.status, "ready")
    assert.deepEqual(sorted(s.vaultRefs()), sorted(s.referenced()))
  })

  test("a switch that lands after a disconnect keeps the older staged switch confirmable", async () => {
    const s = await scenario()
    const first = (await s.connectKey("sk-first")).setup.active
    assert.ok(first)
    const staged = (await s.connectKey("sk-staged", "switch", "xai")).setup.staged
    assert.ok(staged)
    const later = await result(s.start("anthropic", "api_key", "switch"))
    await result(disconnect.handler({ ...s.ctx, payload: { connectionId: first.connectionId } }))

    const landed = await result(s.advance(later.attemptId, { kind: "secret", secret: "sk-ant-later" }))
    assert.deepEqual(landed.status, { status: "connected", role: "active" })
    assert.equal(landed.setup.staged?.connectionId.value, staged.connectionId.value)
    assert.deepEqual(sorted(s.vaultRefs()), sorted(s.referenced()))

    await result(confirmSwitch.handler({ ...s.ctx, payload: { connectionId: staged.connectionId } }))
    assert.deepEqual(sorted(s.vaultRefs()), sorted(s.referenced()))
    const checked = await result(testConnection.handler({ ...s.ctx, payload: { connectionId: staged.connectionId } }))
    assert.equal(checked.setup.active?.status, "ready")
  })

  test("an attempt that wins its claim but loses the final decision is never reported connected", async () => {
    const s = await scenario()
    let raced = false
    const attempts: Attempts = {
      ...s.ai.attempts,
      settle: (workspaceId, attemptId, next) =>
        s.ai.attempts.settle(workspaceId, attemptId, next).chain((won) => {
          if (!won || next.state !== "connected" || raced) return Future.resolve<Error, boolean>(won)
          raced = true
          // A fresh start commits between the winning claim and the emit.
          return s
            .start("openai", "api_key")
            .mapRej((e) => new Error(statusOf(e)))
            .map(() => won)
        }),
    }
    const racing = { ...s.ctx, ai: { ...s.ai, attempts } }
    const started = await result(s.start("openai", "api_key"))
    const step: StepRequest = { kind: "secret", secret: "sk-racing" }

    const first = await result(advanceAuth.handler({ ...racing, payload: { attemptId: started.attemptId, step } }))
    assert.deepEqual(first.status, { status: "failed", reason: "superseded", retry: "restart" })
    const repeated = await result(s.advance(started.attemptId, step))
    assert.deepEqual(repeated.status, first.status)
    assert.equal(repeated.setup.active, null)
  })

  test("a repeated advance after a disconnect reports superseded, not connected", async () => {
    const s = await scenario()
    const started = await result(s.start("openai", "api_key"))
    const step: StepRequest = { kind: "secret", secret: "sk-then-disconnected" }
    const active = (await result(s.advance(started.attemptId, step))).setup.active
    assert.ok(active)
    await result(disconnect.handler({ ...s.ctx, payload: { connectionId: active.connectionId } }))

    const repeated = await result(s.advance(started.attemptId, step))
    assert.deepEqual(repeated.status, { status: "failed", reason: "superseded", retry: "restart" })
  })

  test("a test that overlaps a reconnect leaves the reconnected credential ready", async () => {
    const s = await scenario()
    const active = (await s.connectKey("sk-first-key")).setup.active
    assert.ok(active)
    const vault = s.ai.vault
    const racingVault: SecretVault = {
      ...vault,
      // The reconnect lands while the test reads the old credential; the old one is gone by the time it verifies.
      get: (workspaceId, ref) =>
        s
          .start("openai", "api_key", "reconnect")
          .chain((started) => s.advance(started.attemptId, { kind: "secret", secret: "sk-second-key" }))
          .mapRej((e) => new Error(statusOf(e)))
          .chain(() => vault.get(workspaceId, ref)),
    }
    const racing = { ...s.ctx, ai: { ...s.ai, vault: racingVault } }

    const tested = await result(testConnection.handler({ ...racing, payload: { connectionId: active.connectionId } }))
    assert.equal(tested.setup.active?.connectionId.value, active.connectionId.value)
    assert.equal(tested.setup.active?.status, "ready")
  })

  test("a cancel that races a failed verify deletes the credential the verify kept", async () => {
    const s = await scenario()
    const started = await result(s.start("openai", "api_key"))
    const attempts: Attempts = {
      ...s.ai.attempts,
      // The verify settles `verification_failed`, keeping its credential, between the cancel's read and its write.
      find: (workspaceId, attemptId) =>
        s.ai.attempts.find(workspaceId, attemptId).chain((found) =>
          s
            .advance(started.attemptId, { kind: "secret", secret: "sk-quota" })
            .mapRej((e) => new Error(statusOf(e)))
            .map(() => found)
        ),
    }
    const racing = { ...s.ctx, ai: { ...s.ai, attempts } }

    await result(cancelAuth.handler({ ...racing, payload: { attemptId: started.attemptId } }))
    assert.deepEqual(s.vaultRefs(), [])
  })

  test("an overlapping start that records first leaves its attempt connectable", async () => {
    // Each case races start A against a complete start B at a different point of A's own start.
    const race = async (at: "open" | "find") => {
      const s = await scenario()
      let later: Id<"AiAttempt"> | null = null
      const runLater = <T>(value: T) =>
        s
          .start("openai", "api_key")
          .mapRej((e) => new Error(statusOf(e)))
          .map((started) => {
            later = started.attemptId
            return value
          })
      const attempts: Attempts = {
        ...s.ai.attempts,
        open: (attempt) =>
          s.ai.attempts.open(attempt).chain((refs) => (at === "open" ? runLater(refs) : Future.resolve(refs))),
        find: (workspaceId, attemptId) =>
          s.ai.attempts
            .find(workspaceId, attemptId)
            .chain((found) => (at === "find" && later === null ? runLater(found) : Future.resolve(found))),
      }
      const racing = { ...s.ctx, ai: { ...s.ai, attempts } }

      const earlier = await result(
        startAuth.handler({ ...racing, payload: { provider: "openai", method: "api_key", purpose: "initial" } })
      )
      assert.deepEqual(earlier.status, { status: "failed", reason: "superseded", retry: "restart" }, at)
      assert.ok(later !== null)
      const connected = await result(s.advance(later, { kind: "secret", secret: "sk-later" }))
      assert.deepEqual(connected.status, { status: "connected", role: "active" }, at)
    }
    await race("open")
    await race("find")
  })

  test("the vault holds exactly the credentials the registry references, through every flow", async () => {
    const s = await scenario()
    const matches = (label: string) => assert.deepEqual(sorted(s.vaultRefs()), sorted(s.referenced()), label)

    const device = await result(s.start("openai", "device"))
    if (device.status.status !== "pending" || device.status.challenge.kind !== "device") throw new Error("device")
    s.fake.decideDevice(device.status.challenge.userCode, "approve", "pat@example.test")
    await result(s.advance(device.attemptId, { kind: "poll" }))
    matches("after device connect")

    const quota = await result(s.start("xai", "api_key", "switch"))
    await result(s.advance(quota.attemptId, { kind: "secret", secret: "sk-quota" }))
    await result(cancelAuth.handler({ ...s.ctx, payload: { attemptId: quota.attemptId } }))
    matches("after a failed switch is cancelled")

    const discarded = (await s.connectKey("sk-discard", "switch", "anthropic")).setup.staged
    assert.ok(discarded)
    await result(discardSwitch.handler({ ...s.ctx, payload: { connectionId: discarded.connectionId } }))
    matches("after discard")

    const confirmed = (await s.connectKey("sk-confirm", "switch", "xai")).setup.staged
    assert.ok(confirmed)
    await result(confirmSwitch.handler({ ...s.ctx, payload: { connectionId: confirmed.connectionId } }))
    matches("after confirm")

    await result(disconnect.handler({ ...s.ctx, payload: { connectionId: confirmed.connectionId } }))
    matches("after disconnect")
    assert.deepEqual(s.vaultRefs(), [])
  })

  test("reconnecting the same account keeps its preferences and deletes the replaced credential", async () => {
    const s = await scenario()
    const active = (await s.connectKey("sk-first-key")).setup.active
    assert.ok(active)
    await result(
      setPreferences.handler({
        ...s.ctx,
        payload: { connectionId: active.connectionId, model: "test-c", effort: "high" },
      })
    )
    const before = s.referenced()

    const reconnected = await s.connectKey("sk-second-key", "reconnect")
    assert.deepEqual(reconnected.status, { status: "connected", role: "active" })
    assert.equal(reconnected.setup.active?.connectionId.value, active.connectionId.value)
    assert.deepEqual(reconnected.setup.active?.preferences, { model: "test-c", effort: "high" })
    assert.notDeepEqual(s.referenced(), before)
    assert.deepEqual(sorted(s.vaultRefs()), sorted(s.referenced()))
  })
})
