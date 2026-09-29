import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { Just, Nothing } from "@lib/maybe"
import { Id } from "@be/lib/event-sourcing/event"
import { Session } from "@be/app/session"
import { schemas } from "@be/app/events"
import { type UserActor } from "@be/app/actor"
import { type AiConnections } from "@be/app/ai/connections"

import { MemoryEventDatabase, MemorySessionStore, MemoryLoginCodes, memoryAi } from "@tests/support/memory"
import { result, rejection } from "@tests/support/future"

import { provisionUser } from "@be/domain/auth/provisionUser"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { routeViews } from "@be/domain/ai/routes"
import { FakeProvider } from "@tests/support/test-provider/adapter"

import { controller as startAuth } from "@be/domain/ai/command/startAuthorization"
import { controller as advanceAuth } from "@be/domain/ai/command/advanceAuthorization"
import { controller as testConnection } from "@be/domain/ai/command/testConnection"
import { controller as completeStep } from "@be/domain/ai/command/completeSetupStep"

let emailCounter = 0

async function signedIn(db: MemoryEventDatabase, ai: AiConnections) {
  const userId = await provisionUser(db.withEventStore, `readiness-${++emailCounter}@example.test`).promise(
    (e) => new Error(JSON.stringify(e))
  )
  const actor: UserActor = { type: "User", userId }
  return {
    workspaceId: Workspace.idForOwner(userId),
    ctx: {
      actor,
      auth: { result: "allow" as const, actor },
      session: new Session(new MemorySessionStore(), Nothing()),
      loginCodes: new MemoryLoginCodes(),
      ai,
      withEventStore: db.withEventStore,
    },
  }
}
type Ctx = Awaited<ReturnType<typeof signedIn>>["ctx"]

const statusOf = (response: unknown): string => JSON.stringify(response)

async function connectKey(ctx: Ctx, key: string) {
  const started = await result(
    startAuth.handler({ ...ctx, payload: { provider: "xai", method: "api_key", purpose: "initial" } })
  )
  return result(
    advanceAuth.handler({ ...ctx, payload: { attemptId: started.attemptId, step: { kind: "secret", secret: key } } })
  )
}

describe("AI readiness", () => {
  test("without the test adapter every route is unproven and none can start", async () => {
    const db = new MemoryEventDatabase()
    const ai: AiConnections = {
      ...memoryAi(),
      routes: routeViews("off"),
      adapter: () => Nothing(),
      fakeProvider: Nothing(),
    }
    const { ctx } = await signedIn(db, ai)

    assert.ok(ai.routes.every((route) => route.availability === "unproven"))
    for (const route of ai.routes) {
      const refused = await rejection(startAuth.handler({ ...ctx, payload: { ...route, purpose: "initial" } }))
      assert.match(statusOf(refused), /"status":409/)
    }
  })

  test("Test connection records the provider's current state, not the state at connect time", async () => {
    const db = new MemoryEventDatabase()
    const fake = new FakeProvider("http://localhost:5173/jobs/")
    const ai = memoryAi({ fake })
    const { ctx, workspaceId } = await signedIn(db, ai)
    const connected = await connectKey(ctx, "sk-readiness-key")
    const active = connected.setup.active
    assert.ok(active)
    const grant = fake.grants().find((g) => g.method === "api_key")
    assert.ok(grant)

    const check = async (): Promise<string | undefined> =>
      (await result(testConnection.handler({ ...ctx, payload: { connectionId: active.connectionId } }))).setup.active
        ?.status

    assert.equal(await check(), "ready")
    for (const [provider, expected] of [
      ["revoked", "revoked"],
      ["expired", "expired"],
      ["quota", "quota_exhausted"],
      ["ok", "ready"],
    ] as const) {
      fake.setGrant(grant.id, provider)
      assert.equal(await check(), expected, `provider state ${provider}`)
    }

    // The sealed credential is gone from the vault: readiness cannot be proven, so it reads as revoked.
    const stream = db.entries.filter((e) => e.aggregate_id.value === workspaceId.value)
    const workspace = schemas.hydrate(Workspace, stream).unwrap((message) => message).aggregate
    const credentialRef = workspace.values.ai.active.map((c) => c.credentialRef)
    assert.ok(credentialRef instanceof Just)
    await ai.vault.remove(workspaceId, [credentialRef.value]).promise((e) => e)
    assert.equal(await check(), "revoked")

    const unknown = await rejection(
      testConnection.handler({ ...ctx, payload: { connectionId: Id.random<"AiConnection">() } })
    )
    assert.match(statusOf(unknown), /"status":404/)
  })

  test("setup completes only once a ready connection exists, and repeats emit nothing", async () => {
    const db = new MemoryEventDatabase()
    const ai = memoryAi()
    const { ctx } = await signedIn(db, ai)
    const step = (s: "overview" | "connect") => completeStep.handler({ ...ctx, payload: { step: s } })

    assert.equal((await result(step("overview"))).setup.overviewCompleted, true)
    const afterOverview = db.entries.length
    await result(step("overview"))
    assert.equal(db.entries.length, afterOverview)

    assert.match(statusOf(await rejection(step("connect"))), /"status":409/)

    await connectKey(ctx, "sk-setup-key")
    assert.equal((await result(step("connect"))).setup.setupCompleted, true)
  })

  test("a purpose that does not fit the registry is refused before any attempt opens", async () => {
    const db = new MemoryEventDatabase()
    const ai = memoryAi()
    const { ctx } = await signedIn(db, ai)

    const reconnectNothing = await rejection(
      startAuth.handler({ ...ctx, payload: { provider: "xai", method: "api_key", purpose: "reconnect" } })
    )
    assert.match(statusOf(reconnectNothing), /"status":409/)

    await connectKey(ctx, "sk-purpose-key")
    const secondInitial = await rejection(
      startAuth.handler({ ...ctx, payload: { provider: "xai", method: "api_key", purpose: "initial" } })
    )
    assert.match(statusOf(secondInitial), /"status":409/)

    const polledKey = await result(
      startAuth.handler({ ...ctx, payload: { provider: "xai", method: "api_key", purpose: "switch" } })
    )
    const wrongStep = await rejection(
      advanceAuth.handler({ ...ctx, payload: { attemptId: polledKey.attemptId, step: { kind: "poll" } } })
    )
    assert.match(statusOf(wrongStep), /"status":400/)

    const missing = await rejection(
      advanceAuth.handler({ ...ctx, payload: { attemptId: Id.random<"AiAttempt">(), step: { kind: "poll" } } })
    )
    assert.match(statusOf(missing), /"status":404/)
  })
})
