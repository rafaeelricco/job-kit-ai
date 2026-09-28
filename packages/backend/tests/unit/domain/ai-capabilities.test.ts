import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { type Result, Success } from "@lib/result"
import {
  defaultPreferences,
  checkPreferences,
  type Capabilities,
  type Model,
  type Preferences,
  type PreferenceError,
} from "@be/domain/ai/capabilities"

function model(over: Partial<Model> & { id: string }): Model {
  return { summary: "", recommended: false, efforts: ["low", "medium", "high"], usable: true, reason: null, ...over }
}

function failureReason(result: Result<PreferenceError, Preferences>): PreferenceError {
  if (result instanceof Success) throw new Error("expected a Failure")
  return result.error
}

const CAPS: Capabilities = {
  account: "t•••@example.test",
  billing: "Your ChatGPT plan",
  models: [
    model({ id: "test-a", recommended: true, efforts: ["low", "medium", "high"] }),
    model({ id: "test-b", efforts: ["low", "medium"] }),
    model({ id: "test-c", efforts: ["high"] }),
    model({ id: "test-d", usable: false, reason: "No structured output, can't draft profiles" }),
  ],
}

describe("ai capabilities", () => {
  test("the default picks the recommended usable model at medium", () => {
    assert.deepEqual(defaultPreferences(CAPS), { model: "test-a", effort: "medium" })
  })

  test("the default falls back to the first usable model when none is recommended", () => {
    const caps: Capabilities = { ...CAPS, models: CAPS.models.map((m) => ({ ...m, recommended: false })) }
    assert.deepEqual(defaultPreferences(caps), { model: "test-a", effort: "medium" })
  })

  test("the default falls back to the model's first effort when it doesn't support medium", () => {
    const caps: Capabilities = { ...CAPS, models: [model({ id: "test-c", recommended: true, efforts: ["high"] })] }
    assert.deepEqual(defaultPreferences(caps), { model: "test-c", effort: "high" })
  })

  test("an unusable recommended model is skipped for the first usable one", () => {
    const caps: Capabilities = {
      ...CAPS,
      models: [
        model({ id: "test-d", recommended: true, usable: false }),
        model({ id: "test-b", efforts: ["low", "medium"] }),
      ],
    }
    assert.deepEqual(defaultPreferences(caps), { model: "test-b", effort: "medium" })
  })

  test("an unknown model is rejected", () => {
    assert.equal(failureReason(checkPreferences(CAPS, { model: "test-z", effort: "medium" })), "unknown_model")
  })

  test("an unusable model is rejected", () => {
    assert.equal(failureReason(checkPreferences(CAPS, { model: "test-d", effort: "medium" })), "model_unusable")
  })

  test("an effort the model doesn't support is rejected", () => {
    assert.equal(failureReason(checkPreferences(CAPS, { model: "test-c", effort: "medium" })), "effort_unsupported")
  })

  test("a valid preference passes through unchanged", () => {
    const preferences: Preferences = { model: "test-b", effort: "low" }
    const result = checkPreferences(CAPS, preferences)
    assert.equal(result instanceof Success, true)
    if (result instanceof Success) assert.deepEqual(result.value, preferences)
  })
})
