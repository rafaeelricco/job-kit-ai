import assert from "node:assert/strict"
import { beforeEach, describe, test, vi } from "vitest"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"

import { type LlmRequest, type ProviderOutput, providerLlm } from "@be/app/ai/llm/router"
import { generateWithOpenAI, listOpenAIModels, generateWithXai, listXaiModels } from "@be/app/ai/llm/openai"
import { generateWithAnthropic, listAnthropicModels } from "@be/app/ai/llm/anthropic"

// The SDK calls themselves are exercised against the real APIs, not here: this pins the router's dispatch and metadata.
vi.mock("@be/app/ai/llm/openai", () => ({
  generateWithOpenAI: vi.fn(),
  generateWithXai: vi.fn(),
  listOpenAIModels: vi.fn(),
  listXaiModels: vi.fn(),
}))
vi.mock("@be/app/ai/llm/anthropic", () => ({ generateWithAnthropic: vi.fn(), listAnthropicModels: vi.fn() }))

const run = <T>(f: Future<Error, T>): Promise<T> => f.promise((e) => e)

beforeEach(() => vi.clearAllMocks())

const request: LlmRequest = {
  model: "m-1",
  effort: "medium",
  prompt: "hi",
  systemInstruction: Nothing(),
  maxOutputTokens: 64,
}

const tokens = Just({ input: Just(3), output: Just(2), total: Just(5) })
const answer = (effortSent: boolean): Future<Error, ProviderOutput> =>
  Future.resolve({ text: "OK", tokens, effortSent })

describe("providerLlm.generate", () => {
  test("dispatches to each provider's call with the key and request", async () => {
    vi.mocked(generateWithOpenAI).mockReturnValue(answer(true))
    vi.mocked(generateWithAnthropic).mockReturnValue(answer(true))
    vi.mocked(generateWithXai).mockReturnValue(answer(true))

    await run(providerLlm.generate("openai", "k-o", request))
    await run(providerLlm.generate("anthropic", "k-a", request))
    await run(providerLlm.generate("xai", "k-x", request))

    assert.deepEqual(vi.mocked(generateWithOpenAI).mock.calls, [["k-o", request]])
    assert.deepEqual(vi.mocked(generateWithAnthropic).mock.calls, [["k-a", request]])
    assert.deepEqual(vi.mocked(generateWithXai).mock.calls, [["k-x", request]])
  })

  test("stamps provider, model, effort sent, tokens and a duration", async () => {
    vi.mocked(generateWithOpenAI).mockReturnValue(answer(true))
    const generated = await run(providerLlm.generate("openai", "k", request))

    assert.equal(generated.text, "OK")
    assert.equal(generated.metadata.provider, "openai")
    assert.equal(generated.metadata.model, "m-1")
    assert.deepEqual(generated.metadata.effort, Just("medium"))
    assert.deepEqual(generated.metadata.tokens, tokens)
    assert.ok(generated.metadata.duration.asMilliseconds() >= 0)
  })

  test("reports no effort when the call ran without one", async () => {
    vi.mocked(generateWithXai).mockReturnValue(answer(false))
    const generated = await run(providerLlm.generate("xai", "k", request))
    assert.deepEqual(generated.metadata.effort, Nothing())
  })

  test("does nothing until forked", () => {
    vi.mocked(generateWithOpenAI).mockReturnValue(answer(true))
    providerLlm.generate("openai", "k", request)
    assert.equal(vi.mocked(generateWithOpenAI).mock.calls.length, 0)
  })
})

describe("providerLlm.listModels", () => {
  test("dispatches to each provider's listing", async () => {
    vi.mocked(listOpenAIModels).mockReturnValue(Future.resolve([]))
    vi.mocked(listAnthropicModels).mockReturnValue(Future.resolve([]))
    vi.mocked(listXaiModels).mockReturnValue(Future.resolve([]))

    await run(providerLlm.listModels("openai", "k-o"))
    await run(providerLlm.listModels("anthropic", "k-a"))
    await run(providerLlm.listModels("xai", "k-x"))

    assert.deepEqual(vi.mocked(listOpenAIModels).mock.calls, [["k-o"]])
    assert.deepEqual(vi.mocked(listAnthropicModels).mock.calls, [["k-a"]])
    assert.deepEqual(vi.mocked(listXaiModels).mock.calls, [["k-x"]])
  })
})
