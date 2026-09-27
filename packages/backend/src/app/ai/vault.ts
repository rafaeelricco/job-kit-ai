export { type SecretVault, postgresVault, initializeVaultTable }

import * as d from "@lib/json/decoder"

import { Future } from "@lib/future"
import { type Maybe, Nothing } from "@lib/maybe"
import { type Result, Failure } from "@lib/result"
import { Postgres, type PostgresTransaction } from "@be/lib/postgres"
import { Id } from "@be/lib/event-sourcing/event"

import { type Secret } from "@be/domain/ai/adapter"
import { type VaultKeys, seal, open } from "@be/app/ai/crypto"

/** Outside the replication publication, like `auth_login_codes`: sealed secrets never reach the event bus. */
const TABLE = "ai_secrets"

type SecretVault = {
  readonly put: (workspaceId: Id<"Workspace">, secret: Secret) => Future<Error, Id<"AiSecret">>
  /** `WHERE ref AND workspace_id`; `Nothing` for an unknown ref, another workspace's ref, or a row that fails to open. */
  readonly get: (workspaceId: Id<"Workspace">, ref: Id<"AiSecret">) => Future<Error, Maybe<Secret>>
  /** Idempotent: removing an already-gone or foreign ref is a no-op. */
  readonly remove: (workspaceId: Id<"Workspace">, refs: Id<"AiSecret">[]) => Future<Error, void>
}

const aad = (workspaceId: Id<"Workspace">, ref: Id<"AiSecret">): string => `${workspaceId.value}\n${ref.value}`

/**
 * The `iv`/`ciphertext`/`tag` columns are `BYTEA`; the query layer only accepts JSON-shaped parameters, so they cross
 * the wire as base64 text (`decode($n, 'base64')` on the way in, `encode(col, 'base64')` on the way out) rather than
 * as raw `Buffer`s.
 */
type SealedRow = { key_version: number; iv: string; ciphertext: string; tag: string }

const sealedRowDecoder: d.Decoder<SealedRow> = d.object({
  key_version: d.number,
  iv: d.string,
  ciphertext: d.string,
  tag: d.string,
})

function initializeVaultTable(postgres: Postgres): Future<Error, void> {
  return postgres.withTransaction(
    { isolation: "ReadCommitted" },
    (e) => e,
    (t) =>
      Future.attemptP(async () => {
        await t.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          ref TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          key_version INT NOT NULL,
          iv BYTEA NOT NULL,
          ciphertext BYTEA NOT NULL,
          tag BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)
        await t.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_workspace_id ON ${TABLE} (workspace_id)`)
      })
  )
}

/** A `Failure` key result (`AI_CREDENTIAL_KEYS` unset in production) makes every call reject, rather than silently no-op. */
function postgresVault(postgres: Postgres, keys: Result<string, VaultKeys>): SecretVault {
  if (keys instanceof Failure) {
    // The parse message never contains key material (see `parseVaultKeys`).
    const rejected = <T>(): Future<Error, T> => Future.reject(new Error(keys.error))
    return { put: () => rejected(), get: () => rejected(), remove: () => rejected() }
  }
  const vaultKeys = keys.value

  const run = <T>(f: (t: PostgresTransaction) => Promise<T>): Future<Error, T> =>
    postgres.withTransaction(
      { isolation: "ReadCommitted" },
      (e) => e,
      (t) => Future.attemptP(() => f(t))
    )

  return {
    put: (workspaceId, secret) =>
      run(async (t) => {
        const ref = Id.random<"AiSecret">()
        const sealed = seal(vaultKeys, aad(workspaceId, ref), secret)
        await t.query(
          `INSERT INTO ${TABLE} (ref, workspace_id, key_version, iv, ciphertext, tag)
           VALUES ($1, $2, $3, decode($4, 'base64'), decode($5, 'base64'), decode($6, 'base64'))`,
          [
            ref.value,
            workspaceId.value,
            sealed.keyVersion,
            sealed.iv.toString("base64"),
            sealed.ciphertext.toString("base64"),
            sealed.tag.toString("base64"),
          ]
        )
        return ref
      }),

    get: (workspaceId, ref) =>
      run(async (t) => {
        const { rows } = await t.query(
          `SELECT key_version, encode(iv, 'base64') AS iv, encode(ciphertext, 'base64') AS ciphertext, encode(tag, 'base64') AS tag
           FROM ${TABLE} WHERE ref = $1 AND workspace_id = $2`,
          [ref.value, workspaceId.value]
        )
        const row = rows[0]
        if (row === undefined) return Nothing()
        return d.decode(row, sealedRowDecoder).either<Maybe<Secret>>(
          () => Nothing(),
          (sealed) =>
            open(vaultKeys, aad(workspaceId, ref), {
              keyVersion: sealed.key_version,
              iv: Buffer.from(sealed.iv, "base64"),
              ciphertext: Buffer.from(sealed.ciphertext, "base64"),
              tag: Buffer.from(sealed.tag, "base64"),
            })
        )
      }),

    remove: (workspaceId, refs) =>
      run(async (t) => {
        if (refs.length === 0) return
        await t.query(`DELETE FROM ${TABLE} WHERE workspace_id = $1 AND ref = ANY($2)`, [
          workspaceId.value,
          refs.map((ref) => ref.value),
        ])
      }),
  }
}
