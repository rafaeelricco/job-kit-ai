import { describe, expect, test, vi } from "vitest"
import { Client, type PoolClient, type QueryResult } from "pg"
import { sha256 } from "js-sha256"
import { EventEmitter } from "node:events"
import {
  Postgres,
  defaultPoolSettings,
  schema_BIGINT_as_Number,
  schema_JSONB,
  schema_TimestampTZ,
  ConstraintViolationError,
  SerializationError,
  withDatabase,
  type PostgresTransaction,
} from "@be/lib/postgres"
import { initialize, PostgresEventStoreDb, evaluate } from "@be/lib/event-sourcing/store/postgres"
import { EventStoreCorruptionError, type DatabaseEntry } from "@be/lib/event-sourcing/store"
import { schemas } from "@be/app/events"
import { Id } from "@be/lib/event-sourcing/event"
import { Future } from "@lib/future"
import { POSIX } from "@lib/time"
import { Failure } from "@lib/result"
import * as s from "@lib/json/schema"

const config = {
  user: "test",
  password: "test",
  host: "invalid",
  port: 5432,
  database: "events",
  poolSettings: defaultPoolSettings,
}
const result: QueryResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] }
function harness() {
  const query = vi.fn(async (_sql: unknown, _values?: unknown) => result)
  const release = vi.fn()
  const pool = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => ({ query, release }) as unknown as PoolClient),
    end: vi.fn(async () => {}),
  })
  const db = new Postgres(config)
  Object.assign(db, { pool })
  return { db, query, release, pool }
}
function transaction(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (_sql: unknown, _values?: unknown) => ({ ...result, rows }))
  return { tx: { query } as unknown as PostgresTransaction, query }
}
const entry: DatabaseEntry = {
  event_id: new Id("event-1"),
  aggregate_id: new Id("note-1"),
  aggregate_version: 0,
  correlation_id: new Id("root-1"),
  causation_id: new Id("cause-1"),
  recorded_on: new POSIX(1000),
  event_name: "NoteCreated",
  schema_version: 2,
  payload: { title: "hello" },
}

describe("PostgreSQL value contracts", () => {
  test.each([0, 7, "42", "-42", Number.MAX_SAFE_INTEGER.toString(), Number.MIN_SAFE_INTEGER.toString(), 5n])(
    "decodes safe BIGINT %s",
    (value) => {
      expect(s.decode(schema_BIGINT_as_Number, value).unwrap(String)).toBe(Number(value))
    }
  )
  test.each(["bad", "1.5", "9007199254740992", "-9007199254740992", 9007199254740992n, -9007199254740992n, null, {}])(
    "rejects invalid or unsafe BIGINT %s",
    (value) => {
      expect(s.decode(schema_BIGINT_as_Number, value)).toBeInstanceOf(Failure)
    }
  )
  test("encodes numbers, JSON and timestamps and rejects invalid dates", () => {
    expect(s.encode(schema_BIGINT_as_Number, 42)).toBe(42)
    expect(s.encode(schema_JSONB, { a: [1, true] })).toBe('{"a":[1,true]}')
    expect(s.decode(schema_JSONB, { a: 1 }).unwrap(String)).toEqual({ a: 1 })
    expect(s.decode(schema_TimestampTZ, s.encode(schema_TimestampTZ, new POSIX(1000))).unwrap(String).value).toBe(1000)
    expect(s.decode(schema_TimestampTZ, "not-a-date")).toBeInstanceOf(Failure)
  })
  test("classifies only complete driver errors", () => {
    const constraint = ConstraintViolationError.from({
      code: "23505",
      message: "duplicate",
      constraint: "unique_note",
    }).maybe<unknown>(null, (value) => value)
    expect(constraint).toMatchObject({
      name: "ConstraintViolationError",
      message: "duplicate",
      constraint: "unique_note",
    })
    expect(
      ConstraintViolationError.from({ code: "23505", message: "duplicate" }).maybe<unknown>(null, (value) => value)
    ).toBeNull()
    expect(
      SerializationError.from({ code: "40001", message: "conflict" }).maybe<unknown>(null, (value) => value)
    ).toMatchObject({
      name: "SerializationError",
      message: "conflict",
    })
    expect(
      SerializationError.from({ code: "other", message: "conflict" }).maybe<unknown>(null, (value) => value)
    ).toBeNull()
  })
})

describe("PostgreSQL transaction boundaries", () => {
  test.each([
    ["ReadCommitted", "READ COMMITTED"],
    ["RepeatableRead", "REPEATABLE READ"],
    ["Serializable", "SERIALIZABLE"],
  ] as const)("begins %s lazily and commits once", async (isolation, sql) => {
    const h = harness()
    await h.db.withTransactionP({ isolation }, async (tx) => {
      expect(h.query).not.toHaveBeenCalled()
      await tx.query("SELECT $1", [7])
      await tx.query("SELECT 2")
      return 12
    })
    expect(h.query.mock.calls).toEqual([
      [`START TRANSACTION ISOLATION LEVEL ${sql}`, undefined],
      ["SELECT $1", [7]],
      ["SELECT 2", undefined],
      ["COMMIT", undefined],
    ])
    expect(h.release).toHaveBeenCalledTimes(1)
  })
  test("closed transactions reject repeated commit/abort without more SQL", async () => {
    const h = harness()
    await h.db.withTransactionP({ isolation: "ReadCommitted" }, async (tx) => {
      await tx.abort()
      expect(tx.closed).toBe(true)
      await expect(tx.commit()).rejects.toThrow("Committing a closed transaction")
      await expect(tx.abort()).rejects.toThrow("Aborting a closed transaction")
      await expect(tx.query("SELECT 1")).rejects.toThrow("Querying a closed connection")
    })
    expect(h.query).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledTimes(1)
  })
  test("an early commit followed by callback rejection preserves the error", async () => {
    const h = harness()
    const error = new Error("callback failed")
    await expect(
      h.db.withTransactionP({ isolation: "ReadCommitted" }, async (tx) => {
        await tx.commit()
        throw error
      })
    ).rejects.toBe(error)
    expect(h.release).toHaveBeenCalledTimes(1)
  })
  test("maps acquisition failures without running the callback", async () => {
    const h = harness()
    const action = vi.fn(() => Future.resolve<Error, number>(1))
    h.pool.connect.mockRejectedValue(new Error("offline"))
    await expect(
      h.db.withConnection((e) => new Error(`mapped: ${e.message}`), action).promise((e) => e)
    ).rejects.toThrow("mapped: offline")
    expect(action).not.toHaveBeenCalled()
    expect(h.release).not.toHaveBeenCalled()
  })
  test("failed BEGIN is rolled back and the connection released", async () => {
    const h = harness()
    h.query.mockRejectedValueOnce(new Error("begin failed"))
    await expect(h.db.withTransactionP({ isolation: "ReadCommitted" }, (tx) => tx.query("SELECT 1"))).rejects.toThrow(
      "begin failed"
    )
    expect(h.query.mock.calls.map((c) => c[0])).toEqual([
      "START TRANSACTION ISOLATION LEVEL READ COMMITTED",
      "ROLLBACK",
    ])
    expect(h.release).toHaveBeenCalledTimes(1)
  })
  test.each([new Error("driver"), "driver"])("preserves generic query failure %s", async (error) => {
    const h = harness()
    h.query.mockResolvedValueOnce(result).mockRejectedValueOnce(error)
    await expect(h.db.withTransactionP({ isolation: "ReadCommitted" }, (tx) => tx.query("SELECT 1"))).rejects.toThrow(
      "driver"
    )
    expect(h.release).toHaveBeenCalledTimes(1)
  })
  test("converts generic COMMIT failures and releases", async () => {
    const h = harness()
    h.query.mockResolvedValueOnce(result).mockResolvedValueOnce(result).mockRejectedValueOnce("commit failure")
    await expect(h.db.withTransactionP({ isolation: "ReadCommitted" }, (tx) => tx.query("SELECT 1"))).rejects.toThrow(
      "Failed to commit transaction: commit failure"
    )
    expect(h.release).toHaveBeenCalledTimes(1)
  })
  test("withDatabase disconnects after success and failure", async () => {
    const disconnect = vi.spyOn(Postgres.prototype, "disconnect").mockResolvedValue()
    expect(await withDatabase(config, () => Future.resolve(5)).promise((e) => e)).toBe(5)
    await expect(withDatabase(config, () => Future.reject(new Error("failed"))).promise((e) => e)).rejects.toThrow(
      "failed"
    )
    expect(disconnect).toHaveBeenCalledTimes(2)
  })
  test("standalone connections forward query, notifications and errors, and close", async () => {
    vi.spyOn(Client.prototype, "connect").mockImplementation(async () => {})
    const query = vi.spyOn(Client.prototype, "query").mockImplementation(async () => result)
    const end = vi.spyOn(Client.prototype, "end").mockImplementation(async () => {})
    const on = vi.spyOn(Client.prototype, "on")
    const h = harness()
    const onError = vi.fn()
    const onMessage = vi.fn()
    await h.db
      .withStandaloneConnection(
        (e) => e,
        (connection) =>
          Future.attemptP(async () => {
            await connection.query("SELECT $1", [1])
            await connection.listen({ channel: "events", onError, onMessage })
          })
      )
      .promise((e) => e)
    expect(query).toHaveBeenCalledWith("SELECT $1", [1])
    expect(query).toHaveBeenCalledWith("LISTEN events;", undefined)
    expect(on).toHaveBeenCalledWith("notification", onMessage)
    expect(on).toHaveBeenCalledWith("error", onError)
    expect(end).toHaveBeenCalledTimes(1)
  })
})

describe("event-store PostgreSQL adapter", () => {
  test("checks event existence and binds the ID", async () => {
    const h = transaction()
    const db = new PostgresEventStoreDb(h.tx, "events")
    expect(await db.exists(entry.event_id)).toBe(false)
    h.query.mockResolvedValueOnce({ ...result, rows: [{ exists: 1 }] })
    expect(await db.exists(entry.event_id)).toBe(true)
    expect(h.query.mock.calls[0]?.[0]).toContain("FROM events")
    expect(h.query.mock.calls[0]?.[1]).toEqual(["event-1"])
  })
  test("serializes event columns in parameter order", async () => {
    const h = transaction()
    await new PostgresEventStoreDb(h.tx, "events").insert(entry)
    expect(h.query.mock.calls[0]?.[0]).toContain("INSERT INTO events")
    expect(h.query.mock.calls[0]?.[1]).toEqual([
      "event-1",
      "note-1",
      "cause-1",
      "root-1",
      0,
      '{"title":"hello"}',
      '{"schemaVersion":2}',
      s.encode(schema_TimestampTZ, entry.recorded_on),
      "NoteCreated",
    ])
  })
  test.each([{}, { schemaVersion: 2 }])("decodes history and defaults legacy metadata %j", async (metadata) => {
    const h = transaction([
      {
        event_id: "event-1",
        aggregate_id: "note-1",
        aggregate_version: "0",
        causation_id: "cause-1",
        correlation_id: "root-1",
        recorded_on: "1970-01-01 00:00:01+00",
        event_name: "NoteCreated",
        payload: '{"title":"hello"}',
        json_metadata: JSON.stringify(metadata),
      },
    ])
    const rows = await new PostgresEventStoreDb(h.tx, "events").findAll(entry.aggregate_id)
    expect(rows).toEqual([{ ...entry, schema_version: "schemaVersion" in metadata ? 2 : 1 }])
    expect(h.query.mock.calls[0]?.[0]).toContain("ORDER BY aggregate_version ASC")
    expect(h.query.mock.calls[0]?.[1]).toEqual(["note-1"])
  })
  test("rejects corrupt database rows", async () => {
    const h = transaction([{ event_id: "bad" }])
    await expect(new PostgresEventStoreDb(h.tx, "events").findAll(entry.aggregate_id)).rejects.toBeInstanceOf(
      EventStoreCorruptionError
    )
  })
  test("initializes table, replication and indexes in order; failure stops setup", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const h = transaction()
    const args = {
      transaction: h.tx,
      database: "db",
      table: "events",
      replicationUserName: "replica",
      replicationUserPass: "secret",
      replicationPublication: "pub",
    }
    await initialize(args)
    const sql = h.query.mock.calls.map((c) => String(c[0]))
    expect(sql).toHaveLength(11)
    expect(sql[0]).toContain("CREATE TABLE IF NOT EXISTS events")
    expect(sql[1]).toContain("CREATE USER replica REPLICATION LOGIN PASSWORD ''secret''")
    expect(sql[2]).toBe('GRANT CONNECT ON DATABASE "db" TO replica;')
    expect(sql[3]).toBe("GRANT SELECT ON TABLE events TO replica;")
    expect(sql[4]).toContain("CREATE PUBLICATION pub FOR TABLE events")
    expect(sql.slice(5)).toEqual([
      "CREATE UNIQUE INDEX IF NOT EXISTS event_store_idx_event_aggregate_id_version_862417b9e7c3720b ON events(aggregate_id, aggregate_version);",
      "CREATE UNIQUE INDEX IF NOT EXISTS event_store_idx_event_id_862417b9e7c3720b ON events(event_id);",
      "CREATE INDEX IF NOT EXISTS event_store_idx_event_causation_id_862417b9e7c3720b ON events(causation_id);",
      "CREATE INDEX IF NOT EXISTS event_store_idx_event_correlation_id_862417b9e7c3720b ON events(correlation_id);",
      "CREATE INDEX IF NOT EXISTS event_store_idx_occurred_on_862417b9e7c3720b ON events(recorded_on);",
      "CREATE INDEX IF NOT EXISTS event_store_idx_event_name_862417b9e7c3720b ON events(event_name);",
    ])
    h.query.mockClear().mockRejectedValueOnce(new Error("DDL failed"))
    await expect(initialize(args)).rejects.toThrow("DDL failed")
    expect(h.query).toHaveBeenCalledTimes(1)
  })
  test.each([
    new SerializationError("conflict"),
    new ConstraintViolationError("duplicate", "event_store_idx_event_aggregate_id_version"),
    new ConstraintViolationError("duplicate", "event_store_idx_event_aggregate_id_version_862417b9e7c3720b"),
  ])("retries retryable failures up to ten attempts: %s", async (error) => {
    const h = harness()
    let attempts = 0
    vi.spyOn(h.db, "withTransaction").mockReturnValue(
      Future.create((reject) => {
        attempts++
        reject(error)
      })
    )
    await expect(
      evaluate(h.db, "events", schemas, function* () {
        return 1
      }).promise((e) => e)
    ).rejects.toBe(error)
    expect(attempts).toBe(10)
  })
  test.each([
    new Error("offline"),
    new ConstraintViolationError("duplicate", "other_constraint"),
    new ConstraintViolationError(
      "duplicate",
      `event_store_idx_event_aggregate_id_version_${sha256("other_events").slice(0, 16)}`
    ),
  ])("does not retry unrelated failures: %s", async (error) => {
    const h = harness()
    let attempts = 0
    vi.spyOn(h.db, "withTransaction").mockReturnValue(
      Future.create((reject) => {
        attempts++
        reject(error)
      })
    )
    await expect(
      evaluate(h.db, "events", schemas, function* () {
        return 1
      }).promise((e) => e)
    ).rejects.toBe(error)
    expect(attempts).toBe(1)
  })
  test("evaluates a procedure inside a repeatable-read transaction", async () => {
    const h = harness()
    expect(
      await evaluate(h.db, "events", schemas, function* () {
        return 42
      }).promise((e) => e)
    ).toBe(42)
    expect(h.release).toHaveBeenCalledTimes(1)
  })
})
