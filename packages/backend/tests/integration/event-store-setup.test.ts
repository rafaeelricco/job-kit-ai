import assert from "node:assert/strict"
import { createHash, createHmac, pbkdf2Sync } from "node:crypto"
import { sha256 } from "js-sha256"
import { Client } from "pg"
import { afterEach, beforeEach, test, vi } from "vitest"
import env from "@be/app/environment"
import { initialize } from "@be/lib/event-sourcing/store/postgres"
import type { PostgresTransaction } from "@be/lib/postgres"

const clientConfig = {
  user: env.EVENT_STORE_USER,
  password: env.EVENT_STORE_PASSWORD,
  host: env.EVENT_STORE_HOST,
  port: env.EVENT_STORE_PORT,
  database: env.EVENT_STORE_DATABASE,
}

const indexSpecs = [
  { name: "event_store_idx_event_aggregate_id_version", unique: true, columns: "aggregate_id, aggregate_version" },
  { name: "event_store_idx_event_id", unique: true, columns: "event_id" },
  { name: "event_store_idx_event_causation_id", unique: false, columns: "causation_id" },
  { name: "event_store_idx_event_correlation_id", unique: false, columns: "correlation_id" },
  { name: "event_store_idx_occurred_on", unique: false, columns: "recorded_on" },
  { name: "event_store_idx_event_name", unique: false, columns: "event_name" },
] as const

function expectedIndexName(table: string, name: string): string {
  return `${name}_${sha256(table).slice(0, 16)}`
}

async function expectDuplicateAggregateVersion(client: Client, table: string, marker: string) {
  await client.query("SAVEPOINT duplicate_aggregate_version")
  await client.query(
    `INSERT INTO ${table} (event_id, aggregate_id, aggregate_version, causation_id, correlation_id, recorded_on, event_name, payload, json_metadata)
     VALUES ($1, $2, 0, $3, $4, now(), 'Test', '{}', '{}')`,
    [`${marker}_first`, marker, `${marker}_cause_1`, `${marker}_correlation_1`]
  )

  let duplicateError: unknown
  try {
    await client.query(
      `INSERT INTO ${table} (event_id, aggregate_id, aggregate_version, causation_id, correlation_id, recorded_on, event_name, payload, json_metadata)
       VALUES ($1, $2, 0, $3, $4, now(), 'Test', '{}', '{}')`,
      [`${marker}_second`, marker, `${marker}_cause_2`, `${marker}_correlation_2`]
    )
  } catch (error) {
    duplicateError = error
  }
  assert.equal((duplicateError as { code?: string } | undefined)?.code, "23505")
  await client.query("ROLLBACK TO SAVEPOINT duplicate_aggregate_version")
  await client.query("RELEASE SAVEPOINT duplicate_aggregate_version")
}

function hasPassword(verifier: string, password: string, username: string): boolean {
  if (verifier.startsWith("SCRAM-SHA-256$")) {
    const [, iterationsAndSalt, keys] = verifier.split("$")
    const [iterations, salt] = iterationsAndSalt!.split(":")
    const [storedKey, serverKey] = keys!.split(":")
    const saltedPassword = pbkdf2Sync(password, Buffer.from(salt!, "base64"), Number(iterations), 32, "sha256")
    const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest()
    const expectedStoredKey = createHash("sha256").update(clientKey).digest("base64")
    const expectedServerKey = createHmac("sha256", saltedPassword).update("Server Key").digest("base64")
    return storedKey === expectedStoredKey && serverKey === expectedServerKey
  }

  if (verifier.startsWith("md5")) {
    return verifier === `md5${createHash("md5").update(`${password}${username}`).digest("hex")}`
  }

  return false
}

async function expectNoObjects(
  client: Client,
  names: { schema: string; table: string; role: string; publication: string }
) {
  const result = await client.query(
    `SELECT
       EXISTS (SELECT FROM pg_namespace WHERE nspname = $1) AS schema_exists,
       EXISTS (
         SELECT FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2
       ) AS table_exists,
       EXISTS (SELECT FROM pg_roles WHERE rolname = $3) AS role_exists,
       EXISTS (SELECT FROM pg_publication WHERE pubname = $4) AS publication_exists`,
    [names.schema, names.table, names.role, names.publication]
  )
  assert.deepEqual(result.rows[0], {
    schema_exists: false,
    table_exists: false,
    role_exists: false,
    publication_exists: false,
  })
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

test.each([
  ["ordinary", "SafePass123!"],
  ["apostrophe", "O'Brien"],
  ["backslash", "back\\slash"],
  ["dollar quotes", "before$$after"],
  ["combined", "O'\\$$pass"],
])("initialize stores the exact %s password and rolls back scratch objects", async (_label, password) => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`.replaceAll(".", "")
  const names = {
    schema: `event_store_setup_${suffix}`,
    table: "event_store",
    role: `event_store_setup_role_${suffix}`,
    publication: `event_store_setup_pub_${suffix}`,
  }
  const client = new Client(clientConfig)
  await client.connect()

  let failure: unknown
  try {
    await client.query("BEGIN")
    await client.query(`CREATE SCHEMA ${names.schema}`)
    const transaction = {
      query: (sql: string, values?: unknown[]) => client.query(sql, values),
    } as unknown as PostgresTransaction

    const setup = () =>
      initialize({
        transaction,
        database: env.EVENT_STORE_DATABASE,
        table: `${names.schema}.${names.table}`,
        replicationUserName: names.role,
        replicationUserPass: password,
        replicationPublication: names.publication,
      })

    await setup()

    const role = await client.query<{ rolpassword: string }>("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [
      names.role,
    ])
    assert.equal(role.rows.length, 1)
    assert.ok(
      hasPassword(role.rows[0]!.rolpassword, password, names.role),
      "PostgreSQL stored a verifier for the exact password bytes"
    )

    // The second initialization exercises the duplicate-role and duplicate-publication branches.
    await setup()

    const objects = await client.query(
      `SELECT
         EXISTS (SELECT FROM pg_namespace WHERE nspname = $1) AS schema_exists,
         EXISTS (
           SELECT FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2
         ) AS table_exists,
         EXISTS (SELECT FROM pg_roles WHERE rolname = $3) AS role_exists,
         EXISTS (SELECT FROM pg_publication WHERE pubname = $4) AS publication_exists`,
      [names.schema, names.table, names.role, names.publication]
    )
    assert.deepEqual(objects.rows[0], {
      schema_exists: true,
      table_exists: true,
      role_exists: true,
      publication_exists: true,
    })
  } catch (error) {
    failure = error
  } finally {
    try {
      await client.query("ROLLBACK")
    } catch (error) {
      failure ??= error
    }
    try {
      await expectNoObjects(client, names)
    } catch (error) {
      failure ??= error
    }
    try {
      await client.end()
    } catch (error) {
      failure ??= error
    }
  }

  if (failure !== undefined) throw failure
})

test.each([
  ["event_store", "custom_events"],
  ["custom_events", "event_store"],
])("initialize preserves publication membership and distinct indexes for %s then %s", async (first, second) => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`.replaceAll(".", "")
  const schema = `event_store_collision_${suffix}`
  const publication = `event_store_collision_pub_${suffix}`
  const role = `event_store_collision_role_${suffix}`
  const tables = [first, second]
  const client = new Client(clientConfig)
  await client.connect()

  let failure: unknown
  try {
    await client.query("BEGIN")
    await client.query(`CREATE SCHEMA ${schema}`)
    const transaction = {
      query: (sql: string, values?: unknown[]) => client.query(sql, values),
    } as unknown as PostgresTransaction
    const initializeTable = (table: string) =>
      initialize({
        transaction,
        database: env.EVENT_STORE_DATABASE,
        table: `${schema}.${table}`,
        replicationUserName: role,
        replicationUserPass: "scratch_password",
        replicationPublication: publication,
      })

    await initializeTable(first)
    await expectDuplicateAggregateVersion(client, `${schema}.${first}`, `${suffix}_${first}`)

    // Recreate the fixed pre-upgrade index names on the first table so setup must coexist with them.
    for (const spec of indexSpecs) {
      await client.query(
        `CREATE ${spec.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${spec.name} ON ${schema}.${first}(${spec.columns})`
      )
    }
    await initializeTable(first)
    await initializeTable(second)
    await initializeTable(second)

    const members = await client.query<{ schemaname: string; tablename: string }>(
      "SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = $1 AND schemaname = $2 ORDER BY tablename",
      [publication, schema]
    )
    assert.deepEqual(
      members.rows.map(({ tablename }) => tablename),
      [...tables].sort()
    )

    const expectedByTable = new Map(
      tables.map((table) => [table, indexSpecs.map((spec) => expectedIndexName(`${schema}.${table}`, spec.name))])
    )
    const expectedNames = [...expectedByTable.values()].flat()
    assert.equal(new Set(expectedNames).size, tables.length * indexSpecs.length)
    assert.ok(expectedNames.every((name) => name.length <= 63))

    const indexes = await client.query<{ table_name: string; index_name: string; name_length: number }>(
      `SELECT t.relname AS table_name, i.relname AS index_name, char_length(i.relname) AS name_length
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = ANY($2) AND i.relname = ANY($3)
       ORDER BY t.relname, i.relname`,
      [schema, tables, expectedNames]
    )
    assert.equal(indexes.rows.length, tables.length * indexSpecs.length)
    assert.equal(new Set(indexes.rows.map(({ index_name }) => index_name)).size, tables.length * indexSpecs.length)
    assert.ok(indexes.rows.every(({ name_length, index_name }) => name_length <= 63 && index_name.length <= 63))
    for (const table of tables) {
      assert.deepEqual(
        indexes.rows
          .filter(({ table_name }) => table_name === table)
          .map(({ index_name }) => index_name)
          .sort(),
        expectedByTable.get(table)!.sort()
      )
    }

    await expectDuplicateAggregateVersion(client, `${schema}.${second}`, `${suffix}_${second}`)
  } catch (error) {
    failure = error
  } finally {
    try {
      await client.query("ROLLBACK")
    } catch (error) {
      failure ??= error
    }
    try {
      await expectNoObjects(client, {
        schema,
        table: first,
        role,
        publication,
      })
      await expectNoObjects(client, {
        schema,
        table: second,
        role,
        publication,
      })
    } catch (error) {
      failure ??= error
    }
    try {
      await client.end()
    } catch (error) {
      failure ??= error
    }
  }

  if (failure !== undefined) throw failure
})
