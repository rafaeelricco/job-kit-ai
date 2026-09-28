import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { Just, Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { parseVaultKeys, vaultKeys, seal, open, type VaultKeys } from "@be/app/ai/crypto"

const KEY_1 = Buffer.alloc(32, 1).toString("base64")
const KEY_2 = Buffer.alloc(32, 2).toString("base64")

function unwrap(result: Result<string, VaultKeys>): VaultKeys {
  if (result instanceof Failure) throw new Error(`fixture keys failed to parse: ${result.error}`)
  return result.value
}

function failureMessage(result: Result<string, VaultKeys>): string {
  if (result instanceof Success) throw new Error("expected a Failure")
  return result.error
}

const keysOf = (raw: string): VaultKeys => unwrap(parseVaultKeys(raw))

describe("ai crypto", () => {
  test("seal then open round-trips every secret shape", () => {
    const keys = keysOf(`1:${KEY_1}`)
    const aad = "workspace-1\nref-1"
    for (const secret of [
      { kind: "token" as const, token: "tok_abc" },
      { kind: "key" as const, key: "sk-abc" },
      { kind: "device" as const, deviceCode: "dev_abc" },
    ]) {
      const opened = open(keys, aad, seal(keys, aad, secret))
      assert.equal(opened instanceof Just, true)
      assert.deepEqual(opened.withDefault(secret), secret)
    }
  })

  test("a wrong workspace or ref in the AAD fails to open", () => {
    const keys = keysOf(`1:${KEY_1}`)
    const secret = { kind: "token" as const, token: "tok_abc" }
    const sealed = seal(keys, "workspace-1\nref-1", secret)

    assert.equal(open(keys, "workspace-2\nref-1", sealed) instanceof Nothing, true)
    assert.equal(open(keys, "workspace-1\nref-2", sealed) instanceof Nothing, true)
  })

  test("a tampered tag fails to open", () => {
    const keys = keysOf(`1:${KEY_1}`)
    const aad = "workspace-1\nref-1"
    const sealed = seal(keys, aad, { kind: "key", key: "sk-abc" })
    const tampered = { ...sealed, tag: Buffer.from(sealed.tag) }
    tampered.tag[0] = (tampered.tag[0] ?? 0) ^ 0xff

    assert.equal(open(keys, aad, tampered) instanceof Nothing, true)
  })

  test("an old key version still opens after rotation", () => {
    const before = keysOf(`1:${KEY_1}`)
    const aad = "workspace-1\nref-1"
    const sealed = seal(before, aad, { kind: "device", deviceCode: "dev_old" })

    const rotated = keysOf(`1:${KEY_1},2:${KEY_2}`)
    assert.equal(rotated.current, 2)
    assert.deepEqual(open(rotated, aad, sealed).withDefault({ kind: "device", deviceCode: "" }), {
      kind: "device",
      deviceCode: "dev_old",
    })
  })

  test("a fresh seal after rotation uses the highest version", () => {
    const rotated = keysOf(`1:${KEY_1},2:${KEY_2}`)
    const sealed = seal(rotated, "workspace-1\nref-1", { kind: "key", key: "sk-new" })
    assert.equal(sealed.keyVersion, 2)
  })

  test("empty AI_CREDENTIAL_KEYS uses a fixed development key outside production", () => {
    const keys = unwrap(vaultKeys("", "development"))
    assert.equal(keys.current, 1)
    assert.equal(keys.keys.size, 1)

    const aad = "workspace-1\nref-1"
    const secret = { kind: "token" as const, token: "tok_dev" }
    assert.deepEqual(open(keys, aad, seal(keys, aad, secret)).withDefault(secret), secret)
  })

  test("empty AI_CREDENTIAL_KEYS in production fails closed", () => {
    assert.equal(failureMessage(vaultKeys("", "production")), "AI_CREDENTIAL_KEYS is not set")
  })

  test("a configured AI_CREDENTIAL_KEYS is used in production too", () => {
    assert.equal(vaultKeys(`1:${KEY_1}`, "production") instanceof Success, true)
  })

  test("parseVaultKeys rejects malformed entries without echoing key material", () => {
    const shortKey = Buffer.alloc(16, 3).toString("base64")
    for (const raw of [`nocolon`, `x:${KEY_1}`, `1:${shortKey}`, `0:${KEY_1}`, ""]) {
      const message = failureMessage(parseVaultKeys(raw))
      assert.equal(message.includes(KEY_1), false)
      assert.equal(message.includes(shortKey), false)
    }
  })

  test("parseVaultKeys tolerates blank entries and whitespace", () => {
    const keys = unwrap(parseVaultKeys(` 1:${KEY_1} , ,2:${KEY_2}`))
    assert.equal(keys.keys.size, 2)
    assert.equal(keys.current, 2)
  })
})
