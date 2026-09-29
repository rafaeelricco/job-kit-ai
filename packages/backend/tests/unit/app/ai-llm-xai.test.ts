import assert from "node:assert/strict"
import { beforeEach, describe, test, vi } from "vitest"

import OpenAI, { type ClientOptions } from "openai"

import { Just, Nothing } from "@lib/maybe"
import { rejection } from "@tests/support/future"

import { type LlmRequest } from "@be/app/ai/llm/types"
import { generateWithXai, listXaiModels } from "@be/app/ai/llm/xai"

const create = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())
const constructed = vi.hoisted(() => [] as unknown[])

// Only the client is replaced: the SDK's real error classes stay, because the code under test matches on them.
vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>()
  class MockOpenAI {
    static APIError = actual.default.APIError
    static APIConnectionError = actual.default.APIConnectionError
    static BadRequestError = actual.default.BadRequestError
    readonly chat = { completions: { create } }
    readonly models = { list }
    constructor(options: unknown) {
      constructed.push(options)
    }
  }
  return { default: MockOpenAI }
})

const options: ClientOptions = { baseURL: "https://api.x.ai/v1", apiKey: "xai-test" }

const request: LlmRequest = {
  model: "grok-4.5",
  effort: "high",
  prompt: "diff",
  systemInstruction: Nothing(),
  maxOutputTokens: 64,
}

const completion = {
  choices: [{ message: { content: "Add retry to the token refresh" } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
}

const unsupportedEffort = (): Error =>
  new OpenAI.BadRequestError(
    400,
    { code: "invalid_request_error", message: "reasoning_effort is not supported for model grok-4.5" },
    undefined,
    new Headers()
  )

const run = (r: LlmRequest) => generateWithXai(options, r).promise((e) => e)

beforeEach(() => {
  create.mockReset()
  list.mockReset()
  constructed.length = 0
})

describe("listXaiModels", () => {
  test("lists the text models, and gives one with no `created` the epoch instead of NaN", async () => {
    async function* listing() {
      yield { id: "grok-4", created: 1750000000 }
      yield { id: "grok-imagine-image", created: 1 }
      yield { id: "grok-3" }
    }
    list.mockReturnValue(listing())

    const models = await listXaiModels({ apiKey: "xai-test" }).promise((e) => e)

    assert.deepEqual(
      models.map((m) => m.id),
      ["grok-4", "grok-3"]
    )
    assert.equal(models[0]?.createdAt.value, 1_750_000_000_000)
    assert.equal(models[1]?.createdAt.value, 0)
  })
})

describe("generateWithXai", () => {
  test("sends reasoning_effort and max_completion_tokens once, through a client built from the options", async () => {
    create.mockResolvedValue(completion)

    const output = await run(request)

    assert.deepEqual(constructed, [options])
    assert.deepEqual(create.mock.calls, [
      [
        {
          model: "grok-4.5",
          messages: [{ role: "user", content: "diff" }],
          max_completion_tokens: 64,
          reasoning_effort: "high",
        },
      ],
    ])
    assert.deepEqual(output.text, Just("Add retry to the token refresh"))
    assert.equal(output.effortSent, true)
    assert.deepEqual(output.tokens, Just({ input: Just(1), output: Just(2), total: Just(3) }))
  })

  test("retries once without reasoning_effort when the model rejects it", async () => {
    create.mockRejectedValueOnce(unsupportedEffort()).mockResolvedValueOnce(completion)

    const output = await run(request)

    assert.equal(create.mock.calls.length, 2)
    assert.equal(create.mock.calls[0]?.[0].reasoning_effort, "high")
    assert.equal("reasoning_effort" in create.mock.calls[1]?.[0], false)
    assert.equal(output.effortSent, false)
  })

  test("does not retry an unrelated 400", async () => {
    const error = new OpenAI.BadRequestError(
      400,
      { code: "invalid_request_error", message: "messages must not be empty" },
      undefined,
      new Headers()
    )
    create.mockRejectedValue(error)

    const rejected = await rejection(generateWithXai(options, request))

    assert.equal(rejected, error)
    assert.equal(create.mock.calls.length, 1)
  })

  test("puts the system message before the user message", async () => {
    create.mockResolvedValue(completion)

    await run({ ...request, systemInstruction: Just("be terse") })

    assert.deepEqual(create.mock.calls[0]?.[0].messages, [
      { role: "system", content: "be terse" },
      { role: "user", content: "diff" },
    ])
  })

  test("passes a completion with no text through as Nothing", async () => {
    create.mockResolvedValue({ choices: [] })

    assert.deepEqual((await run(request)).text, Nothing())
  })

  test("logs the version hint on a 426 and rejects with the SDK error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const error = new OpenAI.APIError(426, undefined, "Please update to version 0.1.202 or later", new Headers())
    create.mockRejectedValue(error)

    const rejected = await rejection(generateWithXai(options, request))

    assert.equal(rejected, error)
    assert.equal(create.mock.calls.length, 1)
    assert.equal(logged.mock.calls.length, 1)
    assert.equal(logged.mock.calls[0]?.[0], "xAI rejected XAI_CLIENT_VERSION: bump it in src/app/ai/llm/xai.ts")
  })
})
