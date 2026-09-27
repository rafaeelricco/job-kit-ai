import assert from "node:assert/strict"
import { afterEach, describe, test, vi } from "vitest"
import type { NextFunction, Request, Response } from "express"
import { Client } from "pg"
import { Mongo } from "@be/lib/mongo"
import { Postgres } from "@be/lib/postgres"
import { Future } from "@lib/future"

type Credentials = { username: string; password: string }

const credentialCases: Array<{ name: string; credentials: Credentials }> = [
  {
    name: "ordinary credentials",
    credentials: { username: "ordinary_user", password: "ordinary_password" },
  },
  ...["/", "?", "#", ":", "@", "%"].flatMap((character) => [
    {
      name: `username containing ${JSON.stringify(character)}`,
      credentials: { username: `user${character}name`, password: "ordinary_password" },
    },
    {
      name: `password containing ${JSON.stringify(character)}`,
      credentials: { username: "ordinary_user", password: `pass${character}word` },
    },
  ]),
  {
    name: "combined URL-reserved characters in both fields",
    credentials: { username: "user/?#:@%", password: "pass/?#:@%" },
  },
]

const host = "db.internal"
const port = 5432
const database = "projection_data"

type ParsedPostgresConfig = {
  user: string
  password: string
  host: string
  port: number
  database: string
}

function assertPostgresConfig(actual: ParsedPostgresConfig, credentials: Credentials): void {
  assert.equal(actual.user, credentials.username)
  assert.equal(actual.password, credentials.password)
  assert.equal(actual.host, host)
  assert.equal(actual.port, port)
  assert.equal(actual.database, database)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("database connection credential URL encoding", () => {
  for (const { name, credentials } of credentialCases) {
    test(`Postgres pooled URL parses ${name} with the original fields`, async () => {
      const postgres = new Postgres({
        user: credentials.username,
        password: credentials.password,
        host,
        port,
        database,
        poolSettings: {
          maxConnections: 1,
          minConnections: 0,
          idleTimeoutMillis: 300000,
          connectionTimeoutMillis: 20000,
        },
      })

      try {
        const { pool } = postgres as unknown as { pool: { options: { connectionString: string } } }
        // Parse the exact pooled connection string with the installed pg driver.
        const client = new Client(pool.options) as unknown as { connectionParameters: ParsedPostgresConfig }
        assertPostgresConfig(client.connectionParameters, credentials)
      } finally {
        await postgres.disconnect()
      }
    })

    test(`Postgres standalone connection parses ${name} with the original fields`, async () => {
      const postgres = new Postgres({
        user: credentials.username,
        password: credentials.password,
        host,
        port,
        database,
        poolSettings: {
          maxConnections: 1,
          minConnections: 0,
          idleTimeoutMillis: 300000,
          connectionTimeoutMillis: 20000,
        },
      })
      let parsed: ParsedPostgresConfig | undefined

      vi.spyOn(Client.prototype, "connect").mockImplementation(async function (this: Client) {
        parsed = (this as unknown as { connectionParameters: ParsedPostgresConfig }).connectionParameters
      })
      vi.spyOn(Client.prototype, "end").mockImplementation(async () => {})

      try {
        await postgres
          .withStandaloneConnection<Error, string>(
            (error) => error,
            () => Future.resolve("connected")
          )
          .promise((error) => error)
        assert.ok(parsed)
        assertPostgresConfig(parsed, credentials)
      } finally {
        await postgres.disconnect()
      }
    })

    test(`Mongo constructor options parse ${name} with the original fields`, async () => {
      const settings = { replicaSet: "projection-rs" }
      const mongo = new Mongo({
        user: credentials.username,
        password: credentials.password,
        host,
        port: 27017,
        database,
        settings,
      })

      try {
        const {
          credentials: parsedCredentials,
          hosts,
          dbName,
          replicaSet,
        } = mongo.client.options as unknown as {
          credentials: { username: string; password: string }
          hosts: Array<{ host: string; port: number }>
          dbName: string
          replicaSet: string
        }
        assert.equal(parsedCredentials.username, credentials.username)
        assert.equal(parsedCredentials.password, credentials.password)
        assert.deepEqual(
          hosts.map(({ host: parsedHost, port: parsedPort }) => [parsedHost, parsedPort]),
          [[host, 27017]]
        )
        assert.equal(dbName, database)
        assert.equal(replicaSet, settings.replicaSet)
        assert.equal(mongo.values.user, credentials.username)
        assert.equal(mongo.values.password, credentials.password)
      } finally {
        await mongo.disconnect()
      }
    })
  }
})

type EventBusMiddleware = (typeof import("@be/lib/event-delivery"))["EventBusAuthMiddleware"]

async function eventBusMiddlewareFor(username: string, password: string): Promise<EventBusMiddleware> {
  vi.resetModules()
  vi.stubEnv("EVENT_BUS_USERNAME", username)
  vi.stubEnv("EVENT_BUS_PASSWORD", password)
  return (await import("@be/lib/event-delivery")).EventBusAuthMiddleware
}

function invokeEventBusMiddleware(middleware: EventBusMiddleware, credentials: string) {
  let statusCode: number | undefined
  let responseBody: unknown
  const req = { headers: { authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}` } } as Request
  const res = {
    status(code: number) {
      statusCode = code
      return this
    },
    json(body: unknown) {
      responseBody = body
      return this
    },
  } as unknown as Response
  const next = vi.fn()
  middleware(req, res, next as NextFunction)
  return { statusCode, responseBody, next }
}

describe("event bus Basic authentication", () => {
  const username = "event-bus-user"

  for (const { name, password } of [
    { name: "ordinary passwords", password: "ordinary-password" },
    { name: "passwords beginning with a colon", password: ":leading-colon" },
    { name: "passwords ending with a colon", password: "trailing-colon:" },
    { name: "passwords with multiple colons", password: "first:middle:last" },
  ]) {
    test(`accepts ${name}`, async () => {
      const middleware = await eventBusMiddlewareFor(username, password)
      const result = invokeEventBusMiddleware(middleware, `${username}:${password}`)
      assert.equal(result.next.mock.calls.length, 1)
      assert.equal(result.statusCode, undefined)
    })
  }

  test("rejects credentials without a colon delimiter", async () => {
    const middleware = await eventBusMiddlewareFor(username, "ordinary-password")
    const result = invokeEventBusMiddleware(middleware, username)
    assert.equal(result.next.mock.calls.length, 0)
    assert.equal(result.statusCode, 401)
    assert.deepEqual(result.responseBody, { error: "Basic authentication required" })
  })

  test("rejects a wrong full password even when the username matches", async () => {
    const middleware = await eventBusMiddlewareFor(username, "first:middle:last")
    const result = invokeEventBusMiddleware(middleware, `${username}:first:middle`)
    assert.equal(result.next.mock.calls.length, 0)
    assert.equal(result.statusCode, 401)
    assert.deepEqual(result.responseBody, { error: "Invalid credentials" })
  })

  test("rejects extra colon-delimited password suffixes", async () => {
    const middleware = await eventBusMiddlewareFor(username, "ordinary-password")
    const result = invokeEventBusMiddleware(middleware, `${username}:ordinary-password:extra`)
    assert.equal(result.next.mock.calls.length, 0)
    assert.equal(result.statusCode, 401)
    assert.deepEqual(result.responseBody, { error: "Invalid credentials" })
  })

  test("requires the username to match exactly", async () => {
    const middleware = await eventBusMiddlewareFor(username, "ordinary-password")
    const result = invokeEventBusMiddleware(middleware, `${username}-extra:ordinary-password`)
    assert.equal(result.next.mock.calls.length, 0)
    assert.equal(result.statusCode, 401)
    assert.deepEqual(result.responseBody, { error: "Invalid credentials" })
  })
})
