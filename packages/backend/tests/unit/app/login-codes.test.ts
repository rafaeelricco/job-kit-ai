import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, test } from "vitest"
import { codeDigest } from "@be/app/loginCodes"

describe("codeDigest", () => {
  const digest = codeDigest("key", "pilot@example.test", "123456")

  test("is not the plain SHA-256 of the code", () => {
    assert.notEqual(digest, createHash("sha256").update("123456").digest("hex"))
  })

  test("depends on the key and the address, not only the code", () => {
    assert.notEqual(codeDigest("other-key", "pilot@example.test", "123456"), digest)
    assert.notEqual(codeDigest("key", "copilot@example.test", "123456"), digest)
    assert.equal(codeDigest("key", "pilot@example.test", "123456"), digest)
  })
})
