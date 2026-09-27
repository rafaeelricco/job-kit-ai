export {
  Postgres,
  ConstraintViolationError,
  SerializationError,
  type PoolSettings,
  type Connection,
  type StandaloneConnection,
  type Config,
  type PostgresTransaction,
  type TransactionOptions,
  type TransactionError,
  defaultPoolSettings,
  schema_TimestampTZ,
  schema_JSONB,
  schema_BIGINT_as_Number,
  withDatabase,
}

import * as s from "@lib/json/schema"
import * as d from "@lib/json/decoder"
import * as e from "@lib/json/encoder"

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { type Json } from "@lib/json/types"
import { POSIX } from "@lib/time"
import {
  Pool,
  type PoolConfig,
  type PoolClient,
  type QueryConfig,
  type QueryResult,
  type Notification,
  Client,
  types,
} from "pg"
import { DateTime } from "luxon"
import { Failure, Success } from "@lib/result"
import { List } from "@lib/list"

// !IMPORTANT!
// This is what makes the types below be returned as a string, rather
// than as a Date object as they usually would be with the 'pg' library.
types.setTypeParser(types.builtins.TIMESTAMPTZ, (val) => val)

const ISOLATION_LEVELS = ["ReadCommitted", "RepeatableRead", "Serializable"] as const
type Isolation = (typeof ISOLATION_LEVELS)[number]

// `Record<Isolation, _>` is the exhaustiveness check: a new level without a
// statement here does not compile.
const BEGIN: Record<Isolation, string> = {
  ReadCommitted: "START TRANSACTION ISOLATION LEVEL READ COMMITTED",
  RepeatableRead: "START TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  Serializable: "START TRANSACTION ISOLATION LEVEL SERIALIZABLE",
}

type TransactionOptions = {
  // see https://www.postgresql.org/docs/current/transaction-iso.html
  // ReadCommitted: weakest, allows nonrepeatable/phantom reads and serialization anomalies.
  // RepeatableRead: subject to serialization anomaly.
  // Serializable: strongest; most overhead and conflicts.
  isolation: Isolation
}

/** The three ways a transaction can fail; callers use `instanceof` to react to the specific two, or treat it as a generic `Error`. */
type TransactionError = Error | SerializationError | ConstraintViolationError

/**
 * Recognise the two driver errors callers react to (retry on serialization
 * conflict, report a constraint violation); anything else becomes `fallback`.
 */
function transactionError(error: unknown, fallback: Error): TransactionError {
  const serialization: Maybe<TransactionError> = SerializationError.from(error)
  const constraint: Maybe<TransactionError> = ConstraintViolationError.from(error)
  return serialization.alt(constraint).withDefault(fallback)
}

/**
 * `Idle`: nothing sent yet — BEGIN is deferred to the first query so an unused
 * transaction costs no round trip. `Active`: the first query has asked for BEGIN
 * (set before BEGIN resolves, so a failed BEGIN still gets its ROLLBACK). `Closed`: committed
 * or rolled back, connection returned to the pool; every method now throws.
 */
type TransactionState = "Idle" | "Active" | "Closed"

/**
 * One transaction's connection and lifecycle. `BEGIN` is sent lazily on the
 * first `query()` call (see `TransactionState`); every method throws once
 * `closed`. Managed by `Postgres.withTransaction`, not constructed directly
 * by callers.
 */
class PostgresTransaction {
  private state: TransactionState = "Idle"
  private readonly connection: Connection
  private readonly options: TransactionOptions

  constructor(connection: Connection, options: TransactionOptions) {
    this.connection = connection
    this.options = options
  }

  get closed(): boolean {
    return this.state === "Closed"
  }

  /** Send COMMIT only if a query ever ran, and release the connection back to the pool on every outcome. */
  async commit() {
    if (this.closed) {
      throw new Error("Committing a closed transaction")
    }

    try {
      if (this.state === "Active") {
        await this.connection.query("COMMIT")
      }
    } catch (error) {
      throw transactionError(error, new Error(`Failed to commit transaction: ${error}`))
    } finally {
      this.state = "Closed"
      // The connection must return to the pool on every commit outcome.
      // Serialization conflicts (40001) surface at COMMIT time, so releasing
      // only on success would leak a pooled connection on every conflict.
      await this.release()
    }
  }

  /** Roll back the transaction and always release the connection; logs rather than throws if the rollback itself fails, so cleanup can't be skipped by a broken driver call. */
  async abort() {
    if (this.closed) {
      throw new Error("Aborting a closed transaction")
    }

    try {
      if (this.state === "Active") {
        await this.connection.query("ROLLBACK")
      }
    } catch (error) {
      console.error("Failed to rollback PG transaction", error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.state = "Closed"
      await this.release()
    }
  }

  // Used for early release. Make sure connections go back to the pool
  // as soon as the transaction completes rather than only when the
  // block that holds the transaction finishes executing.
  private async release() {
    if (!this.closed) {
      throw new Error("Releasing an active transaction")
    }

    return await this.connection.release()
  }

  /** Run a query on this transaction's connection, sending `BEGIN` first if this is the first call. Throws if the transaction is closed. */
  async query(
    query: string | QueryConfig<string[]>,
    values?: QueryValue[] | undefined
  ): Promise<QueryResult<Record<string, unknown>>> {
    switch (this.state) {
      case "Closed":
        throw new Error("Querying a closed connection")
      case "Idle":
        this.state = "Active"
        await this.connection.query(BEGIN[this.options.isolation])
        break
      case "Active":
        break
      default:
        return this.state satisfies never
    }

    try {
      return await this.connection.query(query, values)
    } catch (error) {
      throw transactionError(error, error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/**
 * Structural shape of the fields `pg` attaches to a unique-constraint
 * violation (SQLSTATE 23505), decoded off the unknown catch value.
 */
const pgConstraintViolationDecoder: d.Decoder<{
  message: string
  constraint: string
}> = d.object({
  code: d.stringLiteral("23505"),
  constraint: d.string,
  message: d.string,
})

/**
 * Structural shape of the fields `pg` attaches to a serialization failure
 * (SQLSTATE 40001), decoded off the unknown catch value.
 */
const pgSerializationFailureDecoder: d.Decoder<{ message: string }> = d.object({
  code: d.stringLiteral("40001"),
  message: d.string,
})

/** A Postgres unique-constraint violation (SQLSTATE 23505), decoded off the driver's thrown value. `constraint` names the violated constraint so callers can react to specific ones. */
class ConstraintViolationError extends Error {
  override readonly name = "ConstraintViolationError"
  readonly constraint: string

  constructor(message: string, constraint: string) {
    super(message)
    this.constraint = constraint
    Object.setPrototypeOf(this, ConstraintViolationError.prototype)
  }

  static from(error: unknown): Maybe<ConstraintViolationError> {
    return d.decode(error, pgConstraintViolationDecoder).either(
      () => Nothing(),
      (decoded) => Just(new ConstraintViolationError(decoded.message, decoded.constraint))
    )
  }
}

/** A Postgres serialization failure (SQLSTATE 40001) from a `REPEATABLE READ`/`SERIALIZABLE` conflict, decoded off the driver's thrown value. Retryable. */
class SerializationError extends Error {
  override readonly name = "SerializationError"

  constructor(message: string) {
    super(message)
    Object.setPrototypeOf(this, SerializationError.prototype)
  }

  static from(error: unknown): Maybe<SerializationError> {
    return d.decode(error, pgSerializationFailureDecoder).either(
      () => Nothing(),
      (decoded) => Just(new SerializationError(decoded.message))
    )
  }
}

type QueryValue = Json

type PoolSettings = {
  maxConnections: number
  minConnections: number
  idleTimeoutMillis: number
  connectionTimeoutMillis: number
}

const defaultPoolSettings: PoolSettings = {
  maxConnections: 10,
  minConnections: 5,
  idleTimeoutMillis: 300000, // 5 minutes
  connectionTimeoutMillis: 20000, // 20 seconds
}

/**
 * Abstraction to ensure a connection is only released once.
 * Makes early release from within a transaction more convenient.
 */
class Connection {
  private released = false
  private readonly client: PoolClient
  constructor(client: PoolClient) {
    this.client = client
  }

  async query(
    query: string | QueryConfig<string[]>,
    values?: QueryValue[] | undefined
  ): Promise<QueryResult<Record<string, unknown>>> {
    return this.client.query(query, values)
  }

  /** Release the client back to the pool exactly once; further calls are no-ops. */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    // Never throw: release runs inside finally blocks and bracket disposers,
    // where a throw would mask the error that triggered the cleanup.
    try {
      this.client.release()
    } catch (error) {
      console.error("Failed to release PG connection", error as Error)
    }
    return
  }
}

/** A connection that is not part of a pool. */
class StandaloneConnection {
  private ended = false
  private readonly client: Client
  constructor(client: Client) {
    this.client = client
  }

  async query(
    query: string | QueryConfig<string[]>,
    values?: QueryValue[] | undefined
  ): Promise<QueryResult<Record<string, unknown>>> {
    return this.client.query(query, values)
  }

  /** Listen on a notification channel. */
  async listen({
    channel,
    onError,
    onMessage,
  }: {
    channel: string
    onError: (err: Error) => void
    onMessage: (message: Notification) => void
  }) {
    await this.query(`LISTEN ${channel};`)
    this.client.on("notification", onMessage)
    this.client.on("error", onError)
  }

  /** Close the connection. Safe to call more than once. */
  async end(): Promise<void> {
    if (this.ended) return
    await this.client.end()
    this.ended = true
    return
  }
}

type Config = {
  user: string
  password: string
  host: string
  port: number
  database: string
  poolSettings: PoolSettings
}

/** Convenience function to ensure a database connection is wrapperd-up. */
function withDatabase<T>(config: Config, f: (db: Postgres) => Future<Error, T>): Future<Error, T> {
  return Future.bracket(
    Future.create<Error, Postgres>((_, res) => {
      res(new Postgres(config))
    }),
    (db) => Future.attemptP(() => db.disconnect()),
    f
  )
}

/** A connection pool plus the transaction/connection helpers built on it. One instance per process; share it across requests. */
class Postgres {
  private readonly pool: Pool
  private connectionString: string = ""

  constructor(values: {
    user: string
    password: string
    host: string
    port: number
    database: string
    poolSettings: PoolSettings
  }) {
    this.connectionString = `postgresql://${encodeURIComponent(values.user)}:${encodeURIComponent(values.password)}@${values.host}:${values.port}/${values.database}`
    const config: PoolConfig = {
      connectionString: this.connectionString,
      max: values.poolSettings.maxConnections,
      min: values.poolSettings.minConnections,
      idleTimeoutMillis: values.poolSettings.idleTimeoutMillis,
      connectionTimeoutMillis: values.poolSettings.connectionTimeoutMillis,
    }
    this.pool = new Pool(config)
    this.pool.on("error", (err: Error) => {
      console.error("Unexpected error on idle client", err)
    })
  }

  async disconnect(): Promise<void> {
    return this.pool.end()
  }

  /** Ensures acquisition and release of connection. */
  withConnection<E, T>(onConnectionError: (e: Error) => E, f: (c: Connection) => Future<E, T>): Future<E, T> {
    const acquire = Future.attemptP(() => this.pool.connect())
      .mapRej(onConnectionError)
      .map((client) => new Connection(client))

    const release = (conn: Connection) => Future.attemptP(() => conn.release()).mapRej(onConnectionError)

    return Future.bracket(acquire, release, f)
  }

  /** Like `withConnection`, but with a dedicated (non-pooled) client — for `LISTEN`/`NOTIFY` or other session state a pooled connection can't safely hold. */
  withStandaloneConnection<E, T>(
    onConnectionError: (e: Error) => E,
    f: (c: StandaloneConnection) => Future<E, T>
  ): Future<E, T> {
    return Future.bracket(
      Future.attemptP(async () => {
        const client = new Client({
          connectionString: this.connectionString,
          keepAlive: true,
        })
        await client.connect()
        return client
      }).mapRej(onConnectionError),
      (client) => Future.attemptP(() => client.end()).mapRej(onConnectionError),
      (client) => {
        const connection = new StandaloneConnection(client)
        return f(connection)
      }
    )
  }

  /** Promise-based `withTransaction`: same guarantees, thrown/rejected errors surface as a rejected promise. */
  async withTransactionP<T>(options: TransactionOptions, f: (t: PostgresTransaction) => Promise<T>): Promise<T> {
    return this.withTransaction(
      options,
      (e) => e,
      (t) => Future.attemptP(() => f(t))
    ).promise((e) => e)
  }

  /**
   * Execute an action with a transaction that will be automatically
   * committed at the end. Commits or aborts based on whether `f` resolves
   * or rejects, and always releases the connection.
   *
   * ```ts
   * postgres.withTransaction({ isolation: "Serializable" }, onError, (tx) => ...)
   * ```
   */
  withTransaction<E, T>(
    options: TransactionOptions,
    onConnectionError: (e: TransactionError) => E,
    f: (t: PostgresTransaction) => Future<E, T>
  ): Future<E, T> {
    return this.withConnection(onConnectionError, (connection) => {
      const transaction = new PostgresTransaction(connection, options)
      return f(transaction).bichain(
        (err) =>
          transaction.closed
            ? Future.reject(err)
            : Future.attemptP(() => transaction.abort())
                .mapRej(onConnectionError)
                .chain((_) => Future.reject(err)),
        (res) =>
          transaction.closed
            ? Future.resolve(res)
            : Future.attemptP(() => transaction.commit())
                .mapRej(onConnectionError)
                .map(() => res)
      )
    })
  }
}

// Common schemas
/** PostgreSQL TIMESTAMPTZ type. */
const schema_TimestampTZ: s.Schema<POSIX> = s.string.chain(
  (s) => {
    const date = DateTime.fromSQL(s, { zone: "UTC" })
    return date.isValid ? d.succeed(new POSIX(date.toMillis())) : d.fail(`Invalid ISO date: ${s}`)
  },
  (p) => DateTime.fromMillis(p.value, { zone: "UTC" }).toSQL() as string
)

const schema_JSONB: s.Schema<Json> = new s.Schema(d.json, new e.Encoder((v: Json) => JSON.stringify(v)))

function toNumber(bigint: bigint): Maybe<number> {
  if (bigint < BigInt(Number.MIN_SAFE_INTEGER) || bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Nothing()
  }
  return Just(Number(bigint))
}

/**
 * Schema for PostgreSQL BIGINT; decodes BIGINTs as JavaScript numbers (an IEEE 754 number), which results
 * in loss of precision for numbers outside the range [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
 */
const schema_BIGINT_as_Number: s.Schema<number> = new s.Schema(
  new d.Decoder((v) => {
    if (typeof v === "number") return Success(v)

    if (typeof v === "string") {
      let parsed: bigint
      try {
        parsed = BigInt(v)
      } catch {
        return Failure([List.empty(), `Invalid number: ${v}`])
      }

      return toNumber(parsed).maybe<d.DecodeResult<number>>(
        Failure([List.empty(), `Number out of safe integer bounds: ${v}`]),
        (n) => Success(n)
      )
    }

    if (typeof v === "bigint") {
      return toNumber(v).maybe<d.DecodeResult<number>>(
        Failure([List.empty(), `Number out of safe integer bounds: ${v}`]),
        (n) => Success(n)
      )
    }

    return Failure([List.empty(), `Expected number or string but found ${typeof v}`])
  }),
  new e.Encoder((n: number) => n)
)
