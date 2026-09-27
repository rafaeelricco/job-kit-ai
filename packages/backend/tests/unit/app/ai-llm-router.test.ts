import assert from "node:assert/strict"
import { describe, test } from "vitest"

import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { Future } from "@lib/future"
import { rejection } from "@tests/support/future"

import { classifyLlmError, withTransientRetry } from "@be/app/ai/llm/router"

const run = <T>(f: Future<Error, T>): Promise<T> => f.promise((e) => e)

const openaiError = (status: number, message: string): Error =>
  OpenAI.APIError.generate(status, {}, message, new Headers())
const anthropicError = (status: number, message: string): Error =>
  Anthropic.APIError.generate(status, {}, message, new Headers())

describe("classifyLlmError", () => {
  test("401 and 403 map to invalid", () => {
    assert.equal(classifyLlmError(openaiError(401, "Incorrect API key provided")), "invalid")
    assert.equal(classifyLlmError(openaiError(403, "Forbidden")), "invalid")
    assert.equal(classifyLlmError(anthropicError(401, "invalid x-api-key")), "invalid")
    // xAI's real answer to a wrong key (observed against api.x.ai).
    assert.equal(
      classifyLlmError(
        openaiError(400, "Incorrect API key provided. You can obtain an API key from https://console.x.ai.")
      ),
      "invalid"
    )
    assert.equal(classifyLlmError(openaiError(400, "Unsupported value: reasoning_effort")), "unreachable")
    assert.equal(
      classifyLlmError(openaiError(400, "Model grok-x is not available for your API key's region")),
      "unreachable"
    )
  })

  test("402, and a 429 that names a quota, map to quota_exhausted", () => {
    assert.equal(classifyLlmError(openaiError(402, "Payment required")), "quota_exhausted")
    assert.equal(
      classifyLlmError(
        openaiError(429, "You exceeded your current quota, please check your plan and billing details.")
      ),
      "quota_exhausted"
    )
  })

  test("a rate-limit 429, 500, 529, and a bare Error map to unreachable", () => {
    assert.equal(classifyLlmError(openaiError(429, "Rate limit reached for requests")), "unreachable")
    assert.equal(classifyLlmError(openaiError(500, "Internal server error")), "unreachable")
    assert.equal(classifyLlmError(anthropicError(529, "Overloaded")), "unreachable")
    assert.equal(classifyLlmError(new Error("boom")), "unreachable")
  })
})

describe("withTransientRetry", () => {
  test("retries a 503 up to 3 tries, then rejects", async () => {
    let attempts = 0
    const error = openaiError(503, "Service unavailable")
    const rejected = await rejection(
      withTransientRetry(() => {
        attempts++
        return Future.reject<Error, string>(error)
      })
    )
    assert.equal(rejected, error)
    assert.equal(attempts, 3)
  })

  test("does not retry a 401", async () => {
    let attempts = 0
    const error = openaiError(401, "Incorrect API key provided")
    const rejected = await rejection(
      withTransientRetry(() => {
        attempts++
        return Future.reject<Error, string>(error)
      })
    )
    assert.equal(rejected, error)
    assert.equal(attempts, 1)
  })

  test("does not retry a quota error", async () => {
    let attempts = 0
    const error = openaiError(402, "Payment required")
    const rejected = await rejection(
      withTransientRetry(() => {
        attempts++
        return Future.reject<Error, string>(error)
      })
    )
    assert.equal(rejected, error)
    assert.equal(attempts, 1)
  })

  test("does not resend our own error, such as an empty answer", async () => {
    let attempts = 0
    const error = new Error("Provider returned an empty response")
    const rejected = await rejection(
      withTransientRetry(() => {
        attempts++
        return Future.reject<Error, string>(error)
      })
    )
    assert.equal(rejected, error)
    assert.equal(attempts, 1)
  })

  test("retries a connection failure", async () => {
    let attempts = 0
    const value = await run(
      withTransientRetry(() => {
        attempts++
        return attempts < 2
          ? Future.reject<Error, string>(new Anthropic.APIConnectionError({ message: "socket hang up" }))
          : Future.resolve<Error, string>("ok")
      })
    )
    assert.equal(value, "ok")
    assert.equal(attempts, 2)
  })

  test("resolves on a later success", async () => {
    let attempts = 0
    const error = openaiError(503, "Service unavailable")
    const value = await run(
      withTransientRetry(() => {
        attempts++
        return attempts < 2 ? Future.reject<Error, string>(error) : Future.resolve<Error, string>("ok")
      })
    )
    assert.equal(value, "ok")
    assert.equal(attempts, 2)
  })
})
