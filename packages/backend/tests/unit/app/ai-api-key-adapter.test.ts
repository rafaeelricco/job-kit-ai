import assert from "node:assert/strict"
import { describe, test, vi } from "vitest"

import OpenAI from "openai"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"

import { type Route } from "@be/domain/ai/routes"
import { apiKeyAdapter, API_KEY_BILLING } from "@be/app/ai/apiKeyAdapter"
import { type Llm, type ModelListing, type Generated } from "@be/app/ai/llm/router"

const run = <T>(f: Future<Error, T>): Promise<T> => f.promise((e) => e)

const route: Route = { provider: "openai", method: "api_key" }
const VALID_KEY = `sk-${"a".repeat(20)}wxyz`

const listing = (overrides: Partial<ModelListing> = {}): ModelListing => ({
  id: "model-a",
  name: "Model A",
  createdAt: POSIX.now(),
  structuredOutput: Nothing(),
  efforts: Nothing(),
  ...overrides,
})

const okGeneration: Generated = {
  text: "OK",
  metadata: {
    provider: "openai",
    model: "model-a",
    effort: Just("low"),
    duration: Duration.milliseconds(5),
    tokens: Nothing(),
  },
}

/** A stub `Llm` that counts its calls; `listModels`/`generate` default to an empty list and a rejection. */
function fakeLlm(opts: {
  listModels?: () => Future<Error, ModelListing[]>
  generate?: () => Future<Error, Generated>
}): { llm: Llm; calls: { listModels: number; generate: number } } {
  const calls = { listModels: 0, generate: 0 }
  const listModelsImpl = opts.listModels ?? (() => Future.resolve<Error, ModelListing[]>([]))
  const generateImpl = opts.generate ?? (() => Future.reject<Error, Generated>(new Error("generate not stubbed")))
  const llm: Llm = {
    listModels: () => {
      calls.listModels++
      return listModelsImpl()
    },
    generate: () => {
      calls.generate++
      return generateImpl()
    },
  }
  return { llm, calls }
}

describe("apiKeyAdapter verify", () => {
  test("a malformed key is rejected before the provider is ever called", async () => {
    const { llm, calls } = fakeLlm({})
    const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "key", key: "not-a-key" }))
    assert.deepEqual(outcome, { kind: "failed", reason: "invalid" })
    assert.equal(calls.listModels, 0)
    assert.equal(calls.generate, 0)
  })

  test("a device secret handed to verify is invalid too", async () => {
    const { llm } = fakeLlm({})
    const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "device", deviceCode: "x" }))
    assert.deepEqual(outcome, { kind: "failed", reason: "invalid" })
  })

  test("a working key verifies ready, with the newest usable model recommended", async () => {
    const older = listing({
      id: "model-old",
      name: "Model Old",
      createdAt: POSIX.now().subtractDuration(Duration.days(30)),
    })
    const newer = listing({ id: "model-new", name: "Model New", createdAt: POSIX.now() })
    const generated: Generated = {
      text: "OK",
      metadata: {
        provider: "openai",
        model: "model-new",
        effort: Just("low"),
        duration: Duration.milliseconds(5),
        tokens: Nothing(),
      },
    }
    const { llm, calls } = fakeLlm({
      listModels: () => Future.resolve([older, newer]),
      generate: () => Future.resolve(generated),
    })
    const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "key", key: VALID_KEY }))
    if (outcome.kind !== "ready") throw new Error("expected the key to verify ready")
    assert.equal(outcome.capabilities.account, `API key …${VALID_KEY.slice(-4)}`)
    assert.equal(outcome.capabilities.billing, API_KEY_BILLING.openai)
    const recommended = outcome.capabilities.models.find((m) => m.recommended)
    assert.equal(recommended?.id, "model-new")
    assert.equal(calls.generate, 1)
  })

  test("accountId is stable for the same key and account key, and differs otherwise", async () => {
    const build = (key: string, accountKey: string) => {
      const { llm } = fakeLlm({
        listModels: () => Future.resolve([listing()]),
        generate: () => Future.resolve(okGeneration),
      })
      return run(apiKeyAdapter(llm, accountKey).verify(route, { kind: "key", key }))
    }
    const otherKey = `sk-${"b".repeat(20)}zzzz`
    const a = await build(VALID_KEY, "account-key-1")
    const b = await build(VALID_KEY, "account-key-1")
    const c = await build(otherKey, "account-key-1")
    const d = await build(VALID_KEY, "account-key-2")
    if (a.kind !== "ready" || b.kind !== "ready" || c.kind !== "ready" || d.kind !== "ready")
      throw new Error("expected every verify to settle ready")
    assert.equal(a.accountId, b.accountId)
    assert.notEqual(a.accountId, c.accountId)
    assert.notEqual(a.accountId, d.accountId)
  })

  test("an empty effort list or an unsupported structured output makes a model unusable, with its reason", async () => {
    const noEfforts = listing({ id: "model-no-efforts", efforts: Just([]) })
    const noStructured = listing({ id: "model-no-structured", structuredOutput: Just(false) })
    const usable = listing({ id: "model-usable" })
    const { llm } = fakeLlm({
      listModels: () => Future.resolve([noEfforts, noStructured, usable]),
      generate: () => Future.resolve(okGeneration),
    })
    const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "key", key: VALID_KEY }))
    if (outcome.kind !== "ready") throw new Error("expected the key to verify ready")
    const byId = (id: string) => outcome.capabilities.models.find((m) => m.id === id)

    assert.equal(byId("model-no-efforts")?.usable, false)
    assert.equal(byId("model-no-efforts")?.reason, "No reasoning-effort control")
    assert.equal(byId("model-no-structured")?.usable, false)
    assert.equal(byId("model-no-structured")?.reason, "No structured output, can't draft profiles")
    assert.equal(byId("model-usable")?.usable, true)
    assert.equal(byId("model-usable")?.reason, null)
  })

  test("a key that reaches no usable model is reported invalid, without a generation call", async () => {
    const { llm, calls } = fakeLlm({ listModels: () => Future.resolve([listing({ efforts: Just([]) })]) })
    const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "key", key: VALID_KEY }))
    assert.deepEqual(outcome, { kind: "failed", reason: "invalid" })
    assert.equal(calls.generate, 0)
  })

  describe("classifying a failed generation", () => {
    test("a 401 verifies invalid", async () => {
      const { llm } = fakeLlm({
        listModels: () => Future.resolve([listing()]),
        generate: () => Future.reject(OpenAI.APIError.generate(401, {}, "Incorrect API key provided", new Headers())),
      })
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "key", key: VALID_KEY }))
      assert.deepEqual(outcome, { kind: "failed", reason: "invalid" })
      logged.mockRestore()
    })

    test("a quota error verifies quota_exhausted", async () => {
      const { llm } = fakeLlm({
        listModels: () => Future.resolve([listing()]),
        generate: () => Future.reject(OpenAI.APIError.generate(402, {}, "Payment required", new Headers())),
      })
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "key", key: VALID_KEY }))
      assert.deepEqual(outcome, { kind: "failed", reason: "quota_exhausted" })
      logged.mockRestore()
    })

    test("a network error verifies unreachable", async () => {
      const { llm } = fakeLlm({
        listModels: () => Future.resolve([listing()]),
        generate: () => Future.reject(new Error("socket hang up")),
      })
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const outcome = await run(apiKeyAdapter(llm, "account-key").verify(route, { kind: "key", key: VALID_KEY }))
      assert.deepEqual(outcome, { kind: "failed", reason: "unreachable" })
      logged.mockRestore()
    })
  })
})

describe("apiKeyAdapter begin and accept", () => {
  test("begin offers a bare entry form", async () => {
    const { llm } = fakeLlm({})
    const begun = await run(apiKeyAdapter(llm, "account-key").begin(route, Id.random<"AiAttempt">()))
    assert.deepEqual(begun.challenge, { kind: "entry" })
    assert.ok(begun.secret instanceof Nothing)
  })

  test("accept trims the entered value into a key secret", async () => {
    const { llm } = fakeLlm({})
    const secret = await run(apiKeyAdapter(llm, "account-key").accept(route, `  ${VALID_KEY}  `))
    assert.deepEqual(secret, { kind: "key", key: VALID_KEY })
  })
})
