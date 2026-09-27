import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { Future } from "@lib/future"
import { Just } from "@lib/maybe"
import { Success, Failure } from "@lib/result"
import { Id } from "@be/lib/event-sourcing/event"
import { FakeProvider, testAdapter } from "@be/app/ai/testAdapter"
import type { Route } from "@be/domain/ai/routes"

const APP_URL = "http://localhost:5173/jobs/"
const deviceRoute: Route = { provider: "openai", method: "device" }
const apiKeyRoute: Route = { provider: "anthropic", method: "api_key" }

const run = <T>(f: Future<Error, T>): Promise<T> => f.promise((e) => e)

describe("testAdapter device flow", () => {
  test("poll moves from pending to authorized with an idempotent token", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)
    const attemptId = Id.random<"AiAttempt">()

    const begun = await run(adapter.begin(deviceRoute, attemptId))
    if (begun.challenge.kind !== "device") throw new Error("expected a device challenge")
    if (!(begun.secret instanceof Just)) throw new Error("expected a device secret")
    const secret = begun.secret.value

    assert.equal((await run(adapter.poll(deviceRoute, secret))).kind, "pending")

    const decided = fake.decideDevice(begun.challenge.userCode, "approve", "someone@example.test")
    assert.ok(decided instanceof Success)

    const first = await run(adapter.poll(deviceRoute, secret))
    const second = await run(adapter.poll(deviceRoute, secret))
    assert.equal(first.kind, "authorized")
    assert.deepEqual(first, second)
  })

  test("poll reports a denial", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)
    const begun = await run(adapter.begin(deviceRoute, Id.random<"AiAttempt">()))
    if (begun.challenge.kind !== "device") throw new Error("expected a device challenge")
    if (!(begun.secret instanceof Just)) throw new Error("expected a device secret")

    fake.decideDevice(begun.challenge.userCode, "deny", "")
    assert.equal((await run(adapter.poll(deviceRoute, begun.secret.value))).kind, "denied")
  })

  test("poll reports an expired code", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)
    const begun = await run(adapter.begin(deviceRoute, Id.random<"AiAttempt">()))
    if (begun.challenge.kind !== "device") throw new Error("expected a device challenge")
    if (!(begun.secret instanceof Just)) throw new Error("expected a device secret")

    fake.decideDevice(begun.challenge.userCode, "expire", "")
    assert.equal((await run(adapter.poll(deviceRoute, begun.secret.value))).kind, "expired")
  })

  test("rejects an unknown user code", () => {
    const fake = new FakeProvider(APP_URL)
    assert.ok(fake.decideDevice("ZZZZ-ZZZZ", "approve", "") instanceof Failure)
  })
})

describe("testAdapter entry credentials", () => {
  test("the magic words steer what accept registers", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)

    const good = await run(adapter.accept(apiKeyRoute, "sk-good-key"))
    assert.equal((await run(adapter.verify(apiKeyRoute, good))).kind, "ready")

    const invalid = await run(adapter.accept(apiKeyRoute, "sk-invalid-key"))
    assert.deepEqual(await run(adapter.verify(apiKeyRoute, invalid)), { kind: "failed", reason: "invalid" })

    const quota = await run(adapter.accept(apiKeyRoute, "sk-quota-key"))
    assert.deepEqual(await run(adapter.verify(apiKeyRoute, quota)), { kind: "failed", reason: "quota_exhausted" })

    const other = await run(adapter.accept(apiKeyRoute, "sk-other-key"))
    const otherReady = await run(adapter.verify(apiKeyRoute, other))
    if (otherReady.kind !== "ready") throw new Error("expected 'other' to still verify ready")
    assert.equal(otherReady.capabilities.account, "o•••@example.test")
  })

  test("a 'slow' credential never settles", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)
    const slow = await run(adapter.accept(apiKeyRoute, "sk-slow-key"))

    let settled = false
    adapter.verify(apiKeyRoute, slow).fork(
      () => (settled = true),
      () => (settled = true)
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(settled, false)
  })
})

describe("testAdapter verify via issued grants", () => {
  test("ok, revoked, expired, and quota each report through verify", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)
    const credential = await run(adapter.accept(apiKeyRoute, "sk-tracked-key"))
    const grant = fake.grants()[0]
    if (grant === undefined) throw new Error("expected a grant to have been recorded")

    assert.equal((await run(adapter.verify(apiKeyRoute, credential))).kind, "ready")

    fake.setGrant(grant.id, "revoked")
    assert.deepEqual(await run(adapter.verify(apiKeyRoute, credential)), { kind: "failed", reason: "revoked" })

    fake.setGrant(grant.id, "expired")
    assert.deepEqual(await run(adapter.verify(apiKeyRoute, credential)), { kind: "failed", reason: "expired" })

    fake.setGrant(grant.id, "quota")
    assert.deepEqual(await run(adapter.verify(apiKeyRoute, credential)), { kind: "failed", reason: "quota_exhausted" })
  })

  test("an unknown credential verifies as revoked", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)
    const outcome = await run(adapter.verify(apiKeyRoute, { kind: "key", key: "never-issued" }))
    assert.deepEqual(outcome, { kind: "failed", reason: "revoked" })
  })

  test("a device secret handed to verify is always invalid", async () => {
    const fake = new FakeProvider(APP_URL)
    const adapter = testAdapter(fake)
    const outcome = await run(adapter.verify(deviceRoute, { kind: "device", deviceCode: "whatever" }))
    assert.deepEqual(outcome, { kind: "failed", reason: "invalid" })
  })
})
