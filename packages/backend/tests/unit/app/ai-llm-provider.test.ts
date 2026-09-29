import assert from "node:assert/strict"
import { beforeEach, describe, test, vi } from "vitest"

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { rejection } from "@tests/support/future"

import { type LlmRequest, type ProviderOutput } from "@be/app/ai/llm/types"
import { providerLlm } from "@be/app/ai/llm/router"
import { generateWithXai, listXaiModels, xaiClientOptions } from "@be/app/ai/llm/xai"
import { generateWithAnthropic, listAnthropicModels } from "@be/app/ai/llm/anthropic"

// The SDK calls themselves are exercised against the real APIs, not here: this pins the router's dispatch and metadata.
vi.mock("@be/app/ai/llm/xai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@be/app/ai/llm/xai")>()),
  generateWithXai: vi.fn(),
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

const apiKey = (key: string): { kind: "api_key"; key: string } => ({ kind: "api_key", key })
const signedIn = { kind: "xai_oauth", accessToken: "grok-access" } as const

const tokens = Just({ input: Just(3), output: Just(2), total: Just(5) })
const answer = (effortSent: boolean): Future<Error, ProviderOutput> =>
  Future.resolve({ text: Just("OK"), tokens, effortSent })

describe("providerLlm.generate", () => {
  test("dispatches to each provider's call with the key and request", async () => {
    vi.mocked(generateWithAnthropic).mockReturnValue(answer(true))
    vi.mocked(generateWithXai).mockReturnValue(answer(true))

    await run(providerLlm.generate("anthropic", apiKey("k-a"), request))
    await run(providerLlm.generate("xai", apiKey("k-x"), request))

    assert.deepEqual(vi.mocked(generateWithAnthropic).mock.calls, [["k-a", request]])
    assert.deepEqual(vi.mocked(generateWithXai).mock.calls, [[xaiClientOptions(apiKey("k-x")), request]])
  })

  test("sends an xAI sign-in through the CLI proxy", async () => {
    vi.mocked(generateWithXai).mockReturnValue(answer(true))

    await run(providerLlm.generate("xai", signedIn, request))

    const [options] = vi.mocked(generateWithXai).mock.calls[0] ?? []
    assert.deepEqual(options, xaiClientOptions(signedIn))
    assert.equal(options?.baseURL, "https://cli-chat-proxy.grok.com/v1")
    assert.equal(options?.apiKey, "grok-access")
  })

  test("rejects an xAI sign-in for the other providers without calling them", async () => {
    const anthropic = await rejection(providerLlm.generate("anthropic", signedIn, request))

    assert.match(anthropic.message, /Unsupported auth method for anthropic/)
    assert.equal(vi.mocked(generateWithAnthropic).mock.calls.length, 0)
  })

  test("stamps provider, model, effort sent, tokens and a duration", async () => {
    vi.mocked(generateWithAnthropic).mockReturnValue(answer(true))
    const generated = await run(providerLlm.generate("anthropic", apiKey("k"), request))

    assert.equal(generated.text, "OK")
    assert.equal(generated.metadata.provider, "anthropic")
    assert.equal(generated.metadata.model, "m-1")
    assert.deepEqual(generated.metadata.effort, Just("medium"))
    assert.deepEqual(generated.metadata.tokens, tokens)
    assert.ok(generated.metadata.duration.asMilliseconds() >= 0)
  })

  test("reports no effort when the call ran without one", async () => {
    vi.mocked(generateWithXai).mockReturnValue(answer(false))
    const generated = await run(providerLlm.generate("xai", apiKey("k"), request))
    assert.deepEqual(generated.metadata.effort, Nothing())
  })

  test("does nothing until forked", () => {
    vi.mocked(generateWithAnthropic).mockReturnValue(answer(true))
    providerLlm.generate("anthropic", apiKey("k"), request)
    assert.equal(vi.mocked(generateWithAnthropic).mock.calls.length, 0)
  })
})

describe("providerLlm.listModels", () => {
  test("dispatches to each provider's listing", async () => {
    vi.mocked(listAnthropicModels).mockReturnValue(Future.resolve([]))
    vi.mocked(listXaiModels).mockReturnValue(Future.resolve([]))

    await run(providerLlm.listModels("anthropic", apiKey("k-a")))
    await run(providerLlm.listModels("xai", apiKey("k-x")))

    assert.deepEqual(vi.mocked(listAnthropicModels).mock.calls, [["k-a"]])
    assert.deepEqual(vi.mocked(listXaiModels).mock.calls, [[xaiClientOptions(apiKey("k-x"))]])
  })

  test("lists an xAI sign-in's models through the CLI proxy", async () => {
    vi.mocked(listXaiModels).mockReturnValue(Future.resolve([]))

    await run(providerLlm.listModels("xai", signedIn))

    assert.deepEqual(vi.mocked(listXaiModels).mock.calls, [[xaiClientOptions(signedIn)]])
  })

  test("rejects an xAI sign-in for the other providers' listings", async () => {
    const anthropic = await rejection(providerLlm.listModels("anthropic", signedIn))

    assert.match(anthropic.message, /Unsupported auth method for anthropic/)
    assert.equal(vi.mocked(listAnthropicModels).mock.calls.length, 0)
  })
})

describe("providerLlm.generate text", () => {
  const from = (text: Maybe<string>) => {
    vi.mocked(generateWithAnthropic).mockReturnValue(Future.resolve({ text, tokens, effortSent: true }))
    return providerLlm.generate("anthropic", apiKey("k"), request)
  }
  const empty = "Provider returned an empty response"

  test("trims the provider's text", async () => {
    assert.equal((await run(from(Just("  hello  ")))).text, "hello")
  })
  test("rejects an empty string", async () => assert.equal((await rejection(from(Just("")))).message, empty))
  test("rejects whitespace only", async () => assert.equal((await rejection(from(Just(" \n\t ")))).message, empty))
  test("rejects missing text", async () => assert.equal((await rejection(from(Nothing()))).message, empty))
})
