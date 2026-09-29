export { type AttemptState, type Attempt, type Settlement, type Attempts, postgresAttempts, initializeAttemptTable }

import * as d from "@lib/json/decoder"

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing, fromNullable, fromOptional } from "@lib/maybe"
import { Failure } from "@lib/result"
import { POSIX } from "@lib/time"
import { Postgres, type PostgresTransaction, schema_TimestampTZ } from "@be/lib/postgres"
import { Id } from "@be/lib/event-sourcing/event"
import {
  schema_Provider,
  schema_Method,
  schema_Purpose,
  type Provider,
  type Method,
  type Purpose,
} from "@be/domain/ai/routes"
import { schema_Challenge, schema_FailureReason, type Challenge, type FailureReason } from "@be/domain/ai/views"

const TABLE = "ai_attempts"

const ATTEMPT_STATES = [
  "pending",
  "verification_failed",
  "connected",
  "denied",
  "expired",
  "cancelled",
  "superseded",
] as const
type AttemptState = (typeof ATTEMPT_STATES)[number]

const OPEN_STATES: readonly AttemptState[] = ["pending", "verification_failed"]

const LEASE_SECONDS = 30

type Attempt = {
  attemptId: Id<"AiAttempt">
  workspaceId: Id<"Workspace">
  provider: Provider
  method: Method
  purpose: Purpose
  state: AttemptState
  failure: Maybe<FailureReason>
  challenge: Challenge
  secretRef: Maybe<Id<"AiSecret">>
  credentialRef: Maybe<Id<"AiSecret">>
  expiresAt: POSIX
}

type Settlement = { state: AttemptState; failure: Maybe<FailureReason>; credentialRef: Maybe<Id<"AiSecret">> }

type Attempts = {
  readonly open: (attempt: Attempt) => Future<Error, Id<"AiSecret">[]>
  readonly find: (workspaceId: Id<"Workspace">, attemptId: Id<"AiAttempt">) => Future<Error, Maybe<Attempt>>
  readonly claim: (workspaceId: Id<"Workspace">, attemptId: Id<"AiAttempt">) => Future<Error, Maybe<Attempt>>
  readonly settle: (
    workspaceId: Id<"Workspace">,
    attemptId: Id<"AiAttempt">,
    next: Settlement
  ) => Future<Error, boolean>
  readonly cancel: (workspaceId: Id<"Workspace">, attemptId: Id<"AiAttempt">) => Future<Error, Maybe<Id<"AiSecret">[]>>
}

const COLUMNS =
  "attempt_id, workspace_id, provider, method, purpose, state, failure, challenge, secret_ref, credential_ref, expires_at"

type AttemptRow = {
  attempt_id: string
  workspace_id: string
  provider: Provider
  method: Method
  purpose: Purpose
  state: AttemptState
  failure: FailureReason | null
  challenge: Challenge
  secret_ref: string | null
  credential_ref: string | null
  expires_at: POSIX
}

const attemptRowDecoder: d.Decoder<AttemptRow> = d.object({
  attempt_id: d.string,
  workspace_id: d.string,
  provider: schema_Provider.decoder,
  method: schema_Method.decoder,
  purpose: schema_Purpose.decoder,
  state: d.stringEnum([...ATTEMPT_STATES]),
  failure: d.nullable(schema_FailureReason.decoder),
  challenge: schema_Challenge.decoder,
  secret_ref: d.nullable(d.string),
  credential_ref: d.nullable(d.string),
  expires_at: schema_TimestampTZ.decoder,
})

function toAttempt(row: AttemptRow): Attempt {
  return {
    attemptId: new Id<"AiAttempt">(row.attempt_id),
    workspaceId: new Id<"Workspace">(row.workspace_id),
    provider: row.provider,
    method: row.method,
    purpose: row.purpose,
    state: row.state,
    failure: fromNullable(row.failure),
    challenge: row.challenge,
    secretRef: fromNullable(row.secret_ref).map((ref) => new Id<"AiSecret">(ref)),
    credentialRef: fromNullable(row.credential_ref).map((ref) => new Id<"AiSecret">(ref)),
    expiresAt: row.expires_at,
  }
}

function decodeAttemptRow(row: unknown): Attempt {
  const decoded = d.decode(row, attemptRowDecoder)
  if (decoded instanceof Failure) throw new Error(`ai_attempts row failed to decode: ${decoded.error}`)
  return toAttempt(decoded.value)
}

const refRowDecoder: d.Decoder<{ secret_ref: string | null; credential_ref: string | null }> = d.object({
  secret_ref: d.nullable(d.string),
  credential_ref: d.nullable(d.string),
})

function collectRefs(rows: unknown[]): Id<"AiSecret">[] {
  return rows.flatMap((row) => {
    const decoded = d.decode(row, refRowDecoder)
    if (decoded instanceof Failure) throw new Error(`ai_attempts row failed to decode: ${decoded.error}`)
    return [decoded.value.secret_ref, decoded.value.credential_ref]
      .filter((ref): ref is string => ref !== null)
      .map((ref) => new Id<"AiSecret">(ref))
  })
}

function initializeAttemptTable(postgres: Postgres): Future<Error, void> {
  return postgres.withTransaction(
    { isolation: "ReadCommitted" },
    (e) => e,
    (t) =>
      Future.attemptP(async () => {
        await t.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          attempt_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          method TEXT NOT NULL,
          purpose TEXT NOT NULL,
          state TEXT NOT NULL,
          failure TEXT,
          challenge JSONB NOT NULL,
          secret_ref TEXT,
          credential_ref TEXT,
          lease_until TIMESTAMPTZ,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`)
        await t.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_workspace_id ON ${TABLE} (workspace_id)`)
      })
  )
}

function postgresAttempts(postgres: Postgres): Attempts {
  const run = <T>(f: (t: PostgresTransaction) => Promise<T>): Future<Error, T> =>
    postgres.withTransaction(
      { isolation: "ReadCommitted" },
      (e) => e,
      (t) => Future.attemptP(() => f(t))
    )

  return {
    open: (attempt) =>
      run(async (t) => {
        const superseded = await t.query(
          `UPDATE ${TABLE} SET state = 'superseded', lease_until = NULL
           WHERE workspace_id = $1 AND state = ANY($2)
           RETURNING secret_ref, credential_ref`,
          [attempt.workspaceId.value, [...OPEN_STATES]]
        )

        await t.query(`INSERT INTO ${TABLE} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
          attempt.attemptId.value,
          attempt.workspaceId.value,
          attempt.provider,
          attempt.method,
          attempt.purpose,
          attempt.state,
          attempt.failure.asNullable(),
          schema_Challenge.encoder.run(attempt.challenge),
          attempt.secretRef.map((ref) => ref.value).asNullable(),
          attempt.credentialRef.map((ref) => ref.value).asNullable(),
          attempt.expiresAt.toSQLTimestamp(),
        ])

        return collectRefs(superseded.rows)
      }),

    find: (workspaceId, attemptId) =>
      run(async (t) => {
        const { rows } = await t.query(`SELECT ${COLUMNS} FROM ${TABLE} WHERE attempt_id = $1 AND workspace_id = $2`, [
          attemptId.value,
          workspaceId.value,
        ])
        return fromOptional(rows[0]).map(decodeAttemptRow)
      }),

    claim: (workspaceId, attemptId) =>
      run(async (t) => {
        const { rows } = await t.query(
          `UPDATE ${TABLE} SET lease_until = now() + make_interval(secs => $3)
           WHERE attempt_id = $1 AND workspace_id = $2 AND state = ANY($4)
             AND (lease_until IS NULL OR lease_until < now())
           RETURNING ${COLUMNS}`,
          [attemptId.value, workspaceId.value, LEASE_SECONDS, [...OPEN_STATES]]
        )
        return fromOptional(rows[0]).map(decodeAttemptRow)
      }),

    settle: (workspaceId, attemptId, next) =>
      run(async (t) => {
        const { rows } = await t.query(
          `UPDATE ${TABLE} SET state = $3, failure = $4, credential_ref = $5, lease_until = NULL
           WHERE attempt_id = $1 AND workspace_id = $2 AND state = ANY($6)
           RETURNING attempt_id`,
          [
            attemptId.value,
            workspaceId.value,
            next.state,
            next.failure.asNullable(),
            next.credentialRef.map((ref) => ref.value).asNullable(),
            [...OPEN_STATES],
          ]
        )
        return rows.length === 1
      }),

    cancel: (workspaceId, attemptId) =>
      run(async (t): Promise<Maybe<Id<"AiSecret">[]>> => {
        const { rows } = await t.query(
          `SELECT secret_ref, credential_ref FROM ${TABLE}
           WHERE attempt_id = $1 AND workspace_id = $2 AND state = ANY($3)
           FOR UPDATE`,
          [attemptId.value, workspaceId.value, [...OPEN_STATES]]
        )
        if (rows.length === 0) return Nothing()
        await t.query(
          `UPDATE ${TABLE} SET state = 'cancelled', failure = 'cancelled', credential_ref = NULL, lease_until = NULL
           WHERE attempt_id = $1`,
          [attemptId.value]
        )
        return Just(collectRefs(rows))
      }),
  }
}
