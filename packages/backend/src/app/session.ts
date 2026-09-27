export { type SessionStore, Session, postgresSessionStore, initializeSessionTable, sessionToken, readCookie, setCookie }

import { createHash, randomBytes } from "node:crypto"
import { type Request } from "express"
import { Future } from "@lib/future"
import { type Maybe, Just, Nothing, fromOptional } from "@lib/maybe"
import { Postgres, type PostgresTransaction } from "@be/lib/postgres"
import { Id } from "@be/lib/event-sourcing/event"
import env from "@be/app/environment"

/** The session cookie's name. Its value is the raw token, never the user id. */
const COOKIE = "sid"

/**
 * The sessions table. It lives in the event-store database but outside the
 * replication publication, so sessions never reach the event bus.
 */
const TABLE = "auth_sessions"

/** Session lifetime in seconds. It runs from sign-in and does not slide, like express-session with `rolling: false`. */
const TTL_SECONDS = 24 * 60 * 60

/**
 * Server-side sessions. The cookie carries a random token; only its SHA-256 is
 * stored, so a leaked table cannot be replayed as cookies.
 */
type SessionStore = {
  /** Start a session for `userId`; resolves with the raw token for the cookie. */
  readonly create: (userId: Id<"User">) => Future<Error, string>
  /** The user an unexpired token belongs to, if any. */
  readonly find: (token: string) => Future<Error, Maybe<Id<"User">>>
  /** Forget `token`; a no-op when it is unknown or already expired. */
  readonly destroy: (token: string) => Future<Error, void>
}

/**
 * Hash a token for storage and lookup. SHA-256 is enough because the token is
 * 256 random bits, not a guessable password.
 */
const digest = (token: string): string => createHash("sha256").update(token).digest("hex")

/** Create the sessions table and its expiry index if missing. Runs at startup, beside the event-store setup. */
function initializeSessionTable(postgres: Postgres): Future<Error, void> {
  return postgres.withTransaction(
    { isolation: "ReadCommitted" },
    (e) => e,
    (t) =>
      Future.attemptP(async () => {
        await t.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        )`)
        await t.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_expires_at ON ${TABLE} (expires_at)`)
      })
  )
}

/**
 * The production `SessionStore`: one short `ReadCommitted` transaction per call.
 * Expiry is decided by the database clock (`now()`), so app and DB never disagree
 * about whether a session is still valid.
 */
function postgresSessionStore(postgres: Postgres): SessionStore {
  const run = <T>(f: (t: PostgresTransaction) => Promise<T>): Future<Error, T> =>
    postgres.withTransaction(
      { isolation: "ReadCommitted" },
      (e) => e,
      (t) => Future.attemptP(() => f(t))
    )
  return {
    create: (userId) =>
      run(async (t) => {
        const token = randomBytes(32).toString("base64url")
        // Sweeping expired rows on every sign-in keeps the table bounded without a job.
        await t.query(`DELETE FROM ${TABLE} WHERE expires_at <= now()`)
        await t.query(
          `INSERT INTO ${TABLE} (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
          [digest(token), userId.value, TTL_SECONDS]
        )
        return token
      }),
    find: (token) =>
      run(async (t) => {
        const { rows } = await t.query(`SELECT user_id FROM ${TABLE} WHERE token_hash = $1 AND expires_at > now()`, [
          digest(token),
        ])
        const userId = rows[0]?.["user_id"]
        return typeof userId === "string" ? Just(new Id<"User">(userId)) : Nothing()
      }),
    destroy: (token) =>
      run(async (t) => {
        await t.query(`DELETE FROM ${TABLE} WHERE token_hash = $1`, [digest(token)])
      }),
  }
}

/**
 * The session token from the `Cookie` header, parsed by hand in place of
 * cookie-parser. `Nothing` when the header, the `sid` pair, or its value is missing.
 *
 * ```ts
 * sessionToken(req) // Cookie: "theme=dark; sid=abc" → Just("abc")
 * ```
 */
function sessionToken(req: Request): Maybe<string> {
  return readCookie(req, COOKIE)
}

/** A cookie's value from the `Cookie` header; `Nothing` when absent or empty. */
function readCookie(req: Request, name: string): Maybe<string> {
  const pair = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return fromOptional(pair?.slice(name.length + 1)).chain((value) => (value.length > 0 ? Just(value) : Nothing()))
}

/**
 * Build the `Set-Cookie` value for `name`. `HttpOnly` hides the cookie from
 * page scripts, `SameSite=Lax` keeps it off cross-site POSTs, and `Secure`
 * (production only) keeps it off plain HTTP.
 *
 * ```ts
 * setCookie("sid", token, 60) // "sid=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=60"
 * ```
 */
function setCookie(name: string, value: string, maxAge: number, path = "/"): string {
  const secure = env.NODE_ENV === "production" ? "; Secure" : ""
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${secure}`
}

/**
 * A command handler's handle on the request's session — what `req.session` is
 * in express-session. `start` and `end` change the store and record the
 * `Set-Cookie` header the reply will carry.
 */
class Session {
  private readonly store: SessionStore
  private readonly token: Maybe<string>
  private cookie: Maybe<string> = Nothing()

  constructor(store: SessionStore, token: Maybe<string>) {
    this.store = store
    this.token = token
  }

  /**
   * Issue a fresh token for `userId` and queue its `Set-Cookie`. The request's
   * own token is never reused, so a cookie planted before sign-in cannot
   * become a signed-in session.
   */
  start(userId: Id<"User">): Future<Error, void> {
    return this.store.create(userId).map((token) => {
      this.cookie = Just(setCookie(COOKIE, token, TTL_SECONDS))
    })
  }

  /**
   * Destroy the request's session, if it has one. The cookie stays: its token
   * now resolves to anonymous.
   *
   * A clearing `Set-Cookie` would apply unconditionally, so a slow reply could
   * delete the cookie of a newer sign-in.
   */
  end(): Future<Error, void> {
    return this.token.maybe(Future.resolve<Error, void>(undefined), (token) => this.store.destroy(token))
  }

  /** The headers the reply must carry: `Set-Cookie` once `start` has run. */
  get headers(): Record<string, string> {
    return this.cookie.maybe({} as Record<string, string>, (cookie) => ({ "Set-Cookie": cookie }))
  }
}
