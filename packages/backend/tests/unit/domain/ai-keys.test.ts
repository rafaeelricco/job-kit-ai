import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { Just, Nothing } from "@lib/maybe"

import { checkApiKey } from "@be/domain/ai/keys"
import { type Provider } from "@be/domain/ai/routes"

const VALID: Record<Provider, string> = {
  openai: `sk-${"a".repeat(20)}`,
  anthropic: `sk-ant-api${"a".repeat(20)}`,
  xai: `xai-${"a".repeat(20)}`,
}

describe("checkApiKey", () => {
  test("a wrong prefix names the expected one", () => {
    const result = checkApiKey("openai", VALID.xai)
    assert.ok(result instanceof Just)
    assert.equal(result.value, "Expected a key starting with sk-")
  })

  test("a key that's too short is rejected even with the right prefix", () => {
    const result = checkApiKey("openai", "sk-short")
    assert.ok(result instanceof Just)
    assert.equal(result.value, "That key looks too short. Paste the whole key.")
  })

  test("surrounding whitespace is ignored", () => {
    assert.ok(checkApiKey("openai", `  ${VALID.openai}  `) instanceof Nothing)
  })

  test("each provider's valid shape passes", () => {
    for (const provider of Object.keys(VALID) as Provider[]) {
      assert.ok(checkApiKey(provider, VALID[provider]) instanceof Nothing)
    }
  })
})
