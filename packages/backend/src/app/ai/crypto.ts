export { type VaultKeys, type Sealed, parseVaultKeys, vaultKeys, seal, open }

import * as crypto from "node:crypto"

import * as s from "@lib/json/schema"

import { type Result, Success, Failure } from "@lib/result"
import { type Maybe, Just, Nothing } from "@lib/maybe"

import { type Secret } from "@be/domain/ai/adapter"

const KEY_BYTES = 32
const IV_BYTES = 12
const ALGORITHM = "aes-256-gcm"

/** Fixed, deterministic, never used in production: `vaultKeys` refuses an empty `AI_CREDENTIAL_KEYS` there instead. */
const DEV_KEY_VERSION = 1
const DEV_KEY: Buffer = crypto.createHash("sha256").update("job-kit-ai:ai-credential-vault:development").digest()

type VaultKeys = { readonly current: number; readonly keys: ReadonlyMap<number, Buffer> }
type Sealed = { keyVersion: number; iv: Buffer; ciphertext: Buffer; tag: Buffer }

const schema_Secret: s.Schema<Secret> = s.discriminatedUnion([
  s.variant({ kind: "token", token: s.string }),
  s.variant({ kind: "key", key: s.string }),
  s.variant({ kind: "device", deviceCode: s.string }),
])

/** "1:<b64>,2:<b64>"; each key 32 bytes. Never echoes key material in a failure message. */
function parseVaultKeys(raw: string): Result<string, VaultKeys> {
  const keys = new Map<number, Buffer>()
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")

  for (const entry of entries) {
    const sep = entry.indexOf(":")
    if (sep < 0) return Failure("AI_CREDENTIAL_KEYS entry is missing a version prefix")

    const version = Number(entry.slice(0, sep))
    if (!Number.isInteger(version) || version < 1) return Failure("AI_CREDENTIAL_KEYS entry has an invalid version")

    const key = Buffer.from(entry.slice(sep + 1), "base64")
    if (key.length !== KEY_BYTES) return Failure(`AI_CREDENTIAL_KEYS version ${version} is not a 32-byte key`)

    keys.set(version, key)
  }

  if (keys.size === 0) return Failure("AI_CREDENTIAL_KEYS has no entries")

  return Success({ current: Math.max(...keys.keys()), keys })
}

/** Empty `raw` uses a fixed key outside production; in production the vault then rejects every operation. */
function vaultKeys(raw: string, nodeEnv: string): Result<string, VaultKeys> {
  if (raw.trim() !== "") return parseVaultKeys(raw)
  if (nodeEnv === "production") return Failure("AI_CREDENTIAL_KEYS is not set")
  return Success({ current: DEV_KEY_VERSION, keys: new Map([[DEV_KEY_VERSION, DEV_KEY]]) })
}

/** AES-256-GCM, fresh 12-byte IV, AAD = `${workspaceId}\n${ref}` so a row copied to another workspace or ref fails to open. */
function seal(keys: VaultKeys, aad: string, secret: Secret): Sealed {
  const key = keys.keys.get(keys.current)
  if (key === undefined) {
    // `vaultKeys`/`parseVaultKeys` always insert `current` into `keys`; a missing key here is a programmer error.
    throw new Error(`Vault key version ${keys.current} is missing`)
  }

  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const plaintext = Buffer.from(JSON.stringify(s.encode(schema_Secret, secret)), "utf8")
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return { keyVersion: keys.current, iv, ciphertext, tag }
}

/** `Nothing` on any auth/decrypt/parse failure: a missing key version, a wrong AAD, a tampered tag, or malformed JSON. */
function open(keys: VaultKeys, aad: string, sealed: Sealed): Maybe<Secret> {
  const key = keys.keys.get(sealed.keyVersion)
  if (key === undefined) return Nothing()

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, sealed.iv)
    decipher.setAAD(Buffer.from(aad, "utf8"))
    decipher.setAuthTag(sealed.tag)
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()])
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"))
    const decoded = s.decode(schema_Secret, parsed)
    return decoded instanceof Failure ? Nothing() : Just(decoded.value)
  } catch {
    return Nothing()
  }
}
