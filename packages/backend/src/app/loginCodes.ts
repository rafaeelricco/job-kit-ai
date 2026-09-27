export { type LoginCodes, postgresLoginCodes, initializeLoginCodeTable, loginCodeSecretFromEnv, codeDigest }

import { createHmac, randomInt, timingSafeEqual } from "node:crypto"
import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { Postgres, type PostgresTransaction } from "@be/lib/postgres"
import { type Mailer } from "@be/app/mailer"
import env from "@be/app/environment"
import { RESEND_COOLDOWN_SECONDS } from "@be/domain/auth/command/requestCode.api"

/** Outside the replication publication, like `auth_sessions`: codes never reach the event bus. */
const TABLE = "auth_login_codes"
const CODE_TTL_SECONDS = 10 * 60
/** Wrong guesses per address; once spent, no new code is issued until the current one expires. */
const MAX_ATTEMPTS = 5

/** Emailed one-time codes: at most one live code per address, single-use, expiring. */
type LoginCodes = {
  /** Issue a fresh code for `email` (replacing any earlier one) and mail it. A no-op inside the cooldown or a lockout. */
  readonly send: (email: string) => Future<Error, void>
  /** True once for the live code of `email`; the code is deleted on success. */
  readonly consume: (email: string, code: string) => Future<Error, boolean>
}

/**
 * Keyed and bound to the address. A plain SHA-256 of six digits is reversed by trying all 10^6 codes,
 * so without the key a leaked table cannot be turned back into live codes.
 */
const codeDigest = (secret: string, email: string, code: string): string =>
  createHmac("sha256", secret).update(`${email}\n${code}`).digest("hex")
/** Six digits; `randomInt` is uniform, so every code is equally likely. */
const newCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, "0")
const sameDigest = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))

function initializeLoginCodeTable(postgres: Postgres): Future<Error, void> {
  return postgres.withTransaction(
    { isolation: "ReadCommitted" },
    (e) => e,
    (t) =>
      Future.attemptP(async () => {
        await t.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          email TEXT PRIMARY KEY,
          code_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          sent_at TIMESTAMPTZ NOT NULL,
          attempts INT NOT NULL DEFAULT 0
        )`)
      })
  )
}

/** `LOGIN_CODE_SECRET`, or a fixed key in development so a local run needs no setup. */
function loginCodeSecretFromEnv(): string {
  if (env.LOGIN_CODE_SECRET !== "") return env.LOGIN_CODE_SECRET
  // A known key makes stored codes as weak as plain SHA-256: allowed in development only.
  if (env.NODE_ENV === "production") throw new Error("LOGIN_CODE_SECRET is required in production")
  return "local-login-code-secret"
}

function postgresLoginCodes(postgres: Postgres, mailer: Mailer, secret: string): LoginCodes {
  const run = <T>(f: (t: PostgresTransaction) => Promise<T>): Future<Error, T> =>
    postgres.withTransaction(
      { isolation: "ReadCommitted" },
      (e) => e,
      (t) => Future.attemptP(() => f(t))
    )
  const issue = (email: string) =>
    run(async (t) => {
      const code = newCode()
      // Sweeping expired rows on every issue keeps the table bounded without a job. An expired row
      // is past its cooldown and lockout, so deleting it changes nothing the upsert below would decide.
      // SKIP LOCKED leaves rows another issue holds to that issue, so two concurrent sweeps never wait on each other.
      await t.query(
        `DELETE FROM ${TABLE} WHERE email IN (SELECT email FROM ${TABLE} WHERE expires_at <= now() FOR UPDATE SKIP LOCKED)`
      )
      // Attempts carry over a resend while the code is live, so resending never buys more guesses.
      const { rows } = await t.query(
        `INSERT INTO ${TABLE} (email, code_hash, expires_at, sent_at, attempts)
         VALUES ($1, $2, now() + make_interval(secs => $3), now(), 0)
         ON CONFLICT (email) DO UPDATE SET
           code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           sent_at = now(),
           attempts = CASE WHEN ${TABLE}.expires_at <= now() THEN 0 ELSE ${TABLE}.attempts END
         WHERE ${TABLE}.sent_at <= now() - make_interval(secs => $4)
           AND (${TABLE}.attempts < $5 OR ${TABLE}.expires_at <= now())
         RETURNING email`,
        [email, codeDigest(secret, email, code), CODE_TTL_SECONDS, RESEND_COOLDOWN_SECONDS, MAX_ATTEMPTS]
      )
      return rows.length === 1 ? Just(code) : Nothing()
    })
  return {
    send: (email) =>
      issue(email).map((mcode) => {
        // Mailed after the reply is decided, so a listed address answers as fast as an unlisted one;
        // a failed send is recovered by Resend.
        if (mcode instanceof Just)
          mailer
            .send({
              to: email,
              subject: `${mcode.value} is your Job Kit sign-in code`,
              text: `Your Job Kit sign-in code is ${mcode.value}. It expires in 10 minutes and works once.\n\nIf you did not ask for it, ignore this email.`,
            })
            .fork(
              (error) => console.error(error),
              () => {}
            )
      }),
    consume: (email, code) =>
      run(async (t) => {
        const { rows } = await t.query(
          `SELECT code_hash, attempts FROM ${TABLE} WHERE email = $1 AND expires_at > now() FOR UPDATE`,
          [email]
        )
        const hash = rows[0]?.["code_hash"]
        const attempts = rows[0]?.["attempts"]
        if (typeof hash !== "string" || typeof attempts !== "number" || attempts >= MAX_ATTEMPTS) return false
        if (!sameDigest(hash, codeDigest(secret, email, code))) {
          await t.query(`UPDATE ${TABLE} SET attempts = attempts + 1 WHERE email = $1`, [email])
          return false
        }
        await t.query(`DELETE FROM ${TABLE} WHERE email = $1`, [email])
        return true
      }),
  }
}
