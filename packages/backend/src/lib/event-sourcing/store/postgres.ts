export { initialize, evaluate, PostgresEventStoreDb }

import * as s from "@lib/json/schema"
import { escapeLiteral } from "pg"
import { sha256 } from "js-sha256"

import { Id, type Aggregate, type IdOf } from "@be/lib/event-sourcing/event"
import {
  type DatabaseEntry,
  type EventStoreDatabase,
  Schemas,
  createEventStore,
  evaluate as evaluateP,
  type EventStore,
  type Procedure,
  EventStoreCorruptionError,
} from "@be/lib/event-sourcing/store"
import {
  type PostgresTransaction,
  Postgres,
  SerializationError,
  ConstraintViolationError,
  type TransactionError,
} from "@be/lib/postgres"
import { schema_BIGINT_as_Number, schema_TimestampTZ } from "@be/lib/postgres"
import { Future } from "@lib/future"

/**
 * Create a callback for evaluating database computations without other side-effects.
 * Handles retries.
 */
function evaluate<T>(
  postgres: Postgres,
  eventStoreTable: string,
  schemas: Schemas,
  f: (s: EventStore) => Procedure<T>
): Future<Error, T> {
  const transaction: Future<TransactionError, T> = postgres.withTransaction(
    { isolation: "RepeatableRead" },
    (e) => e,
    (t) => {
      const db = new PostgresEventStoreDb(t, eventStoreTable)
      const es = createEventStore(db, schemas)
      return Future.attemptP(() => evaluateP(es, f))
    }
  )

  return retrying(transaction, eventStoreTable)
}

const MAX_RETRIES = 10

/**
 * Retry on transaction failures caused by conflicts with other parallel transactions.
 * Doesn't backoff because we expect these to be cheap and not associated with load.
 */
function retrying<T>(f: Future<TransactionError, T>, eventStoreTable: string): Future<TransactionError, T> {
  const attempt = (retries: number): Future<TransactionError, T> =>
    f.chainRej((e: TransactionError) =>
      isRetryableError(e, eventStoreTable) && retries + 1 < MAX_RETRIES ? attempt(retries + 1) : Future.reject(e)
    )

  return attempt(0)
}

function isRetryableError(e: TransactionError, eventStoreTable: string): boolean {
  if (e instanceof SerializationError) {
    return true
  }
  // duplicate aggregate version.
  if (e instanceof ConstraintViolationError) {
    return (
      e.constraint === AGGREGATE_VERSION_INDEX || e.constraint === indexName(eventStoreTable, AGGREGATE_VERSION_INDEX)
    )
  }
  return false
}

type PgRow = Omit<DatabaseEntry, "schema_version"> & {
  json_metadata: { schemaVersion: number }
}

const schema_pg_DatabaseEntry: s.Schema<DatabaseEntry> = s
  .object({
    event_id: Id.schema<"Event">(),
    event_name: s.string,
    json_metadata: s.stringified(s.object({ schemaVersion: s.optionalDefault(1, s.number) })),
    aggregate_id: Id.schema<string>(),
    aggregate_version: schema_BIGINT_as_Number,
    correlation_id: Id.schema<"Event">(),
    causation_id: Id.schema<"Event">(),
    recorded_on: schema_TimestampTZ,
    payload: s.stringified(s.json),
  })
  .dimap(
    ({ json_metadata, ...rest }: PgRow): DatabaseEntry => ({
      ...rest,
      schema_version: json_metadata.schemaVersion,
    }),
    ({ schema_version, ...rest }): PgRow => ({
      ...rest,
      json_metadata: { schemaVersion: schema_version },
    })
  )

type EncodedRow = {
  event_id: string
  event_name: string
  aggregate_id: string
  aggregate_version: number
  correlation_id: string
  causation_id: string
  recorded_on: string
  payload: string
  json_metadata: string
}

/** `EventStoreDatabase` backed by Postgres: the event-sourcing engine's storage adapter for one event-store table, scoped to one transaction. */
class PostgresEventStoreDb implements EventStoreDatabase {
  // An instance of this class never lives longer than the transaction
  // it is associated with.
  private transaction: PostgresTransaction
  private readonly eventStoreTable: string
  constructor(transaction: PostgresTransaction, eventStoreTable: string) {
    this.transaction = transaction
    this.eventStoreTable = eventStoreTable
  }

  /** Whether an event with this id has already been recorded (used for idempotent event ingestion). */
  async exists(eventId: Id<"Event">): Promise<boolean> {
    const sql = `
      SELECT 1
      FROM ${this.eventStoreTable}
      WHERE event_id = $1`

    const result = await this.transaction.query(sql, [eventId.value])
    return result.rows.length > 0
  }

  /** All recorded events for one aggregate, oldest first. */
  async findAll<T extends Aggregate<string>>(aggregateId: IdOf<T>): Promise<DatabaseEntry[]> {
    const sql = `
      SELECT id, event_id, aggregate_id, causation_id, correlation_id,
             aggregate_version, payload, json_metadata, recorded_on, event_name
      FROM ${this.eventStoreTable}
      WHERE aggregate_id = $1
      ORDER BY aggregate_version ASC`

    const result = await this.transaction.query(sql, [aggregateId.value])
    return s.decode(s.array(schema_pg_DatabaseEntry), result.rows).either(
      (e) => {
        throw new EventStoreCorruptionError(`Invalid database entry: ${e}`)
      },
      (entries) => entries
    )
  }

  async insert(entry: DatabaseEntry) {
    const sql = `
      INSERT INTO ${this.eventStoreTable} (
          event_id, aggregate_id, causation_id, correlation_id,
          aggregate_version, payload, json_metadata, recorded_on, event_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

    // `encode` returns the schema's `Json` shape; naming it as the row of
    // columns we're about to bind (rather than casting through `any`) keeps
    // the one unavoidable cast — the encoder's output type is `Json`, not
    // this exact object shape — narrow and self-documenting.
    const serialized = s.encode(schema_pg_DatabaseEntry, entry) as EncodedRow

    const values = [
      serialized.event_id,
      serialized.aggregate_id,
      serialized.causation_id,
      serialized.correlation_id,
      serialized.aggregate_version,
      serialized.payload,
      serialized.json_metadata,
      serialized.recorded_on,
      serialized.event_name,
    ]

    await this.transaction.query(sql, values)
  }
}

type SetupNames = {
  database: string
  table: string
  replicationUserName: string
  replicationUserPass: string
  replicationPublication: string
}

type SetupStep = { description: string; sql: string }

const AGGREGATE_VERSION_INDEX = "event_store_idx_event_aggregate_id_version"

function indexName(table: string, name: string): string {
  return `${name}_${sha256(table).slice(0, 16)}`
}

/**
 * Pure list of the DDL statements that prepare a table as an event store, in order.
 * Kept separate from `initialize` so the SQL text and step order can be inspected
 * and tested without a database.
 */
function setupSteps({
  database,
  table,
  replicationUserName,
  replicationUserPass,
  replicationPublication,
}: SetupNames): ReadonlyArray<SetupStep> {
  function index(description: string, options: { unique: boolean }, name: string, columns: string): SetupStep {
    return {
      description,
      sql: `CREATE ${options.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${indexName(table, name)} ON ${table}(${columns});`,
    }
  }

  return [
    // Create table
    {
      description: `Creating table ${table}`,
      sql: `CREATE TABLE IF NOT EXISTS ${table} (
         id BIGSERIAL NOT NULL,
         event_id TEXT NOT NULL UNIQUE,
         aggregate_id TEXT NOT NULL,
         aggregate_version BIGINT NOT NULL,
         causation_id TEXT NOT NULL,
         correlation_id TEXT NOT NULL,
         recorded_on TIMESTAMPTZ NOT NULL,
         event_name TEXT NOT NULL,
         payload TEXT NOT NULL,
         json_metadata TEXT NOT NULL,
         PRIMARY KEY (id)
     );`,
    },

    // Create replication user
    {
      description: "Creating replication user",
      sql: `DO ${escapeLiteral(` BEGIN
       CREATE USER ${replicationUserName} REPLICATION LOGIN PASSWORD ${escapeLiteral(replicationUserPass)};
     EXCEPTION WHEN duplicate_object THEN
       NULL;
     END `)};`,
    },

    // Grant permissions to replication user
    {
      description: "Granting permissions to replication user",
      sql: `GRANT CONNECT ON DATABASE "${database}" TO ${replicationUserName};`,
    },

    // Grant select to replication user
    {
      description: "Granting select to replication user",
      sql: `GRANT SELECT ON TABLE ${table} TO ${replicationUserName};`,
    },

    // Create publication for table
    {
      description: "Creating publication for table",
      sql: `DO $$
     BEGIN
       CREATE PUBLICATION ${replicationPublication} FOR TABLE ${table};
     EXCEPTION WHEN duplicate_object THEN
       BEGIN
         ALTER PUBLICATION ${replicationPublication} ADD TABLE ${table};
       EXCEPTION WHEN duplicate_object THEN
         NULL;
       END;
     END $$;`,
    },

    // Create indexes for table
    index(
      "Creating aggregate id, aggregate version index",
      { unique: true },
      AGGREGATE_VERSION_INDEX,
      "aggregate_id, aggregate_version"
    ),

    // Create id index for table
    index("Creating id index", { unique: true }, "event_store_idx_event_id", "event_id"),

    // Create causation index for table
    index("Creating causation index", { unique: false }, "event_store_idx_event_causation_id", "causation_id"),

    // Create correlation index for table
    index("Creating correlation index", { unique: false }, "event_store_idx_event_correlation_id", "correlation_id"),

    // Create recording index for table
    index("Creating recording index", { unique: false }, "event_store_idx_occurred_on", "recorded_on"),

    // Create event name index for table
    index("Creating event name index", { unique: false }, "event_store_idx_event_name", "event_name"),
  ]
}

/** Prepare the database to be used as an event store: run `setupSteps` in order, logging each. */
async function initialize({ transaction, ...names }: SetupNames & { transaction: PostgresTransaction }): Promise<void> {
  for (const step of setupSteps(names)) {
    console.log(step.description)
    await transaction.query(step.sql)
  }
}
