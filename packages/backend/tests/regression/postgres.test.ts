import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { type PoolClient, type QueryConfig, type QueryResult } from "pg"
import { Postgres, SerializationError } from "@be/lib/postgres"

/* Connection-leak regression tests.

   A SERIALIZABLE conflict (SQLSTATE 40001) surfaces at COMMIT time. If the
   failed-COMMIT path skips releasing the PoolClient, every conflict leaks one
   pooled connection until the pool is exhausted and all later queries time
   out. These tests pin the invariant that the connection returns to the pool
   on every transaction outcome, and that release itself never throws (a
   throwing release inside a finally or bracket disposer would mask the
   original error). */

type FakeBehavior = { failOnExact?: string; throwOnRelease?: boolean }

class FakeClient {
  public released = 0
  public readonly queries: string[] = []

  private readonly behavior: FakeBehavior

  constructor(behavior: FakeBehavior = {}) {
    this.behavior = behavior
  }

  async query(q: string | QueryConfig<string[]>, _values?: unknown[]): Promise<QueryResult> {
    const text = typeof q === "string" ? q : q.text
    this.queries.push(text)
    if (this.behavior.failOnExact !== undefined && text === this.behavior.failOnExact) {
      const err = new Error("could not serialize access due to read/write dependencies among transactions") as Error & {
        code?: string
      }
      err.code = "40001"
      throw err
    }
    return {
      command: "",
      rowCount: 0,
      oid: 0,
      rows: [],
      fields: [],
    } as unknown as QueryResult
  }

  release(): void {
    this.released += 1
    if (this.behavior.throwOnRelease) {
      throw new Error("release failed")
    }
  }
}

function postgresWithClient(client: FakeClient): Postgres {
  const postgres = new Postgres({
    user: "test_user",
    password: "test_password",
    host: "localhost",
    port: 5432,
    database: "test_database",
    poolSettings: {
      maxConnections: 1,
      minConnections: 0,
      idleTimeoutMillis: 300000,
      connectionTimeoutMillis: 20000,
    },
  })
  ;(postgres as unknown as { pool: { connect: () => Promise<PoolClient> } }).pool = {
    connect: async () => client as unknown as PoolClient,
  }
  return postgres
}

async function expectThrows(f: () => Promise<unknown>, check?: (error: Error) => void): Promise<void> {
  try {
    await f()
  } catch (error) {
    check?.(error as Error)
    return
  }
  assert.fail("expected the call to throw")
}

describe("Postgres transaction connection handling", () => {
  test("successful commit releases the connection exactly once (double-release safe)", async () => {
    const client = new FakeClient()
    const postgres = postgresWithClient(client)
    const result = await postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
      await tx.query("SELECT 1")
      return "ok"
    })
    assert.equal(result, "ok")
    assert.equal(client.queries.includes("COMMIT"), true)
    assert.equal(client.released, 1)
  })

  test("commit without queries skips COMMIT and still releases", async () => {
    const client = new FakeClient()
    const postgres = postgresWithClient(client)
    await postgres.withTransactionP({ isolation: "Serializable" }, async () => undefined)
    assert.equal(client.queries.includes("COMMIT"), false)
    assert.equal(client.released, 1)
  })

  test("failed COMMIT (40001) releases the connection and raises SerializationError", async () => {
    const client = new FakeClient({ failOnExact: "COMMIT" })
    const postgres = postgresWithClient(client)
    await expectThrows(
      () =>
        postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
          await tx.query("INSERT INTO event_store DEFAULT VALUES")
        }),
      (error) => {
        assert.equal(error instanceof SerializationError, true)
      }
    )
    assert.equal(client.released, 1)
  })

  test("callback failure rolls back, releases, and propagates the original error", async () => {
    const client = new FakeClient()
    const postgres = postgresWithClient(client)
    await expectThrows(
      () =>
        postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
          await tx.query("SELECT 1")
          throw new Error("domain failure")
        }),
      (error) => {
        assert.equal(error.message, "domain failure")
      }
    )
    assert.equal(client.queries.includes("ROLLBACK"), true)
    assert.equal(client.released, 1)
  })

  test("failed ROLLBACK still releases and propagates the original error", async () => {
    const client = new FakeClient({ failOnExact: "ROLLBACK" })
    const postgres = postgresWithClient(client)
    await expectThrows(
      () =>
        postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
          await tx.query("SELECT 1")
          throw new Error("domain failure")
        }),
      (error) => {
        assert.equal(error.message, "domain failure")
      }
    )
    assert.equal(client.released, 1)
  })

  test("query failure (40001) maps to SerializationError and releases via abort", async () => {
    const client = new FakeClient({
      failOnExact: "INSERT INTO event_store DEFAULT VALUES",
    })
    const postgres = postgresWithClient(client)
    await expectThrows(
      () =>
        postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
          await tx.query("INSERT INTO event_store DEFAULT VALUES")
        }),
      (error) => {
        assert.equal(error instanceof SerializationError, true)
      }
    )
    assert.equal(client.released, 1)
  })

  test("a throwing client release does not mask a successful result", async () => {
    const client = new FakeClient({ throwOnRelease: true })
    const postgres = postgresWithClient(client)
    const result = await postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
      await tx.query("SELECT 1")
      return "ok"
    })
    assert.equal(result, "ok")
    assert.equal(client.released, 1)
  })

  test("a throwing client release does not mask a failed COMMIT's SerializationError", async () => {
    const client = new FakeClient({
      failOnExact: "COMMIT",
      throwOnRelease: true,
    })
    const postgres = postgresWithClient(client)
    await expectThrows(
      () =>
        postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
          await tx.query("INSERT INTO event_store DEFAULT VALUES")
        }),
      (error) => {
        assert.equal(error instanceof SerializationError, true)
      }
    )
    assert.equal(client.released, 1)
  })

  test("query on a transaction closed while idle throws without touching the connection", async () => {
    const client = new FakeClient()
    const postgres = postgresWithClient(client)
    await postgres.withTransactionP({ isolation: "Serializable" }, async (tx) => {
      await tx.commit()
      await expectThrows(
        () => tx.query("SELECT 1"),
        (error) => {
          assert.equal(error.message, "Querying a closed connection")
        }
      )
    })
    assert.equal(client.queries.length, 0)
    assert.equal(client.released, 1)
  })
})
