import assert from "node:assert/strict"
import { beforeEach, describe, test, vi } from "vitest"

import Anthropic from "@anthropic-ai/sdk"

import { Just, Nothing } from "@lib/maybe"

import { type LlmRequest } from "@be/app/ai/llm/types"
import { generateWithAnthropic, listAnthropicModels } from "@be/app/ai/llm/anthropic"

const stream = vi.hoisted(() => vi.fn())
const modelsList = vi.hoisted(() => vi.fn())

// Only the client is replaced: the SDK's real error classes stay, because the code under test matches on them.
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>()
  class MockAnthropic {
    static APIError = actual.default.APIError
    static APIConnectionError = actual.default.APIConnectionError
    static BadRequestError = actual.default.BadRequestError
    readonly messages = { stream }
    readonly models = { list: modelsList }
  }
  return { default: MockAnthropic }
})

const request: LlmRequest = {
  model: "claude-sonnet-5",
  effort: "low",
  prompt: "diff",
  systemInstruction: Just("rules"),
  maxOutputTokens: 64,
}

const message = (text: string) => ({
  content: [{ type: "text", text }],
  usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
})
const answering = (text: string) => ({ finalMessage: vi.fn().mockResolvedValue(message(text)) })
const failing = (error: Error) => ({ finalMessage: vi.fn().mockRejectedValue(error) })

const effortRejected = (): Error =>
  Anthropic.APIError.generate(400, undefined, "output_config.effort: this model does not support effort", new Headers())

const run = (r: LlmRequest) => generateWithAnthropic("sk-ant-test", r).promise((e) => e)

beforeEach(() => {
  stream.mockReset()
  stream.mockReturnValue(answering("feat: test"))
})

describe("generateWithAnthropic", () => {
  test("sends the system instruction as a cached block, the prompt as the user message, and the effort", async () => {
    const output = await run(request)

    assert.deepEqual(stream.mock.calls, [
      [
        {
          model: "claude-sonnet-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "diff" }],
          output_config: { effort: "low" },
          system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }],
        },
      ],
    ])
    assert.deepEqual(output.text, Just("feat: test"))
    assert.equal(output.effortSent, true)
    // Cached input tokens count as input: 1 + 3 + 4.
    assert.deepEqual(output.tokens, Just({ input: Just(8), output: Just(2), total: Just(10) }))
  })

  test("sends no system when there is no instruction", async () => {
    await run({ ...request, systemInstruction: Nothing() })

    assert.equal(stream.mock.calls.length, 1)
    assert.equal("system" in (stream.mock.calls[0]?.[0] ?? {}), false)
  })

  test("retries once without output_config when the model rejects the effort", async () => {
    stream.mockReturnValueOnce(failing(effortRejected())).mockReturnValueOnce(answering("feat: test"))

    const output = await run(request)

    assert.equal(stream.mock.calls.length, 2)
    assert.deepEqual(stream.mock.calls[0]?.[0].output_config, { effort: "low" })
    assert.equal("output_config" in stream.mock.calls[1]?.[0], false)
    assert.deepEqual(output.text, Just("feat: test"))
    assert.equal(output.effortSent, false)
  })

  test("passes a blank answer through for the router to reject", async () => {
    stream.mockReturnValue(answering("  "))

    const output = await run(request)

    assert.deepEqual(output.text, Just("  "))
    assert.equal(stream.mock.calls.length, 1)
  })
})

describe("listAnthropicModels", () => {
  const yes = { supported: true }
  const no = { supported: false }
  const listed = (id: string, effort: Record<string, unknown>) => ({
    id,
    display_name: id,
    created_at: "2026-05-01T00:00:00Z",
    capabilities: { structured_outputs: yes, effort: { supported: true, ...effort } },
  })

  test("reads every SDK effort level the model reports, an absent xhigh or max as unsupported", async () => {
    modelsList.mockReturnValue([
      listed("claude-new", { low: yes, medium: yes, high: yes, xhigh: yes, max: no }),
      listed("claude-old", { low: yes, medium: yes, high: yes }),
    ])

    const models = await listAnthropicModels("sk-ant-test").promise((e) => e)

    assert.deepEqual(
      models.map((m) => m.efforts),
      [Just(["low", "medium", "high", "xhigh"]), Just(["low", "medium", "high"])]
    )
  })
})
