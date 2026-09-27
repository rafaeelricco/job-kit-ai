import assert from "node:assert/strict"
import { describe, test } from "vitest"
import type * as express from "express"
import { Future } from "@lib/future"
import * as s from "@lib/json/schema"
import { json, type Response } from "@be/lib/router"
import { PlainEndpoint } from "@be/app/endpoint"
import { type CommandController, type QueryController } from "@be/app/handlers"
import { handleCommand } from "@be/app/handleCommand"
import { handleQuery } from "@be/app/handleQuery"
import { type Repositories } from "@be/app/projections"
import { type ProjectionReader, type WithProjectionReader } from "@be/app/projectionStore"
import { internalServerError } from "@be/app/responses"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Id } from "@be/lib/event-sourcing/event"
import { MemoryEventDatabase, MemorySessionStore, MemoryLoginCodes } from "@tests/support/memory"

type Captured = { status: number; body: unknown; headers: Record<string, string> }

function invoke(handler: express.Handler, body: unknown, headers: Record<string, string> = {}): Promise<Captured> {
  return new Promise((resolve) => {
    let status = 200
    let sent: Record<string, string> = {}
    const response = {
      status(code: number) {
        status = code
        return response
      },
      set(value: Record<string, string>) {
        sent = { ...sent, ...value }
        return response
      },
      json(value: unknown) {
        resolve({ status, body: value, headers: sent })
        return response
      },
      send(value: unknown) {
        resolve({ status, body: value, headers: sent })
        return response
      },
    } as unknown as express.Response
    handler({ body, headers } as express.Request, response, (() => {}) as express.NextFunction)
  })
}

describe("HTTP command and query adapters", () => {
  test("decodes commands, encodes successful replies, and maps handler rejections", async () => {
    const endpoint = new PlainEndpoint({
      path: "/command",
      request: s.object({ value: s.number }),
      response: s.object({ accepted: s.number }),
    })
    const controller: CommandController<{ value: number }, { accepted: number }> = {
      endpoint,
      authGuard: Auth.public(),
      handler: ({ payload }) =>
        payload.value < 0
          ? Future.reject(json({ status: 409, content: { error: { message: "value must be nonnegative" } } }))
          : Future.resolve({ accepted: payload.value }),
    }
    const handler = handleCommand(
      new MemoryEventDatabase().withEventStore,
      new MemorySessionStore(),
      new MemoryLoginCodes(),
      controller
    )

    const decoded = await invoke(handler, { value: "wrong" })
    assert.equal(decoded.status, 400)
    assert.match(JSON.stringify(decoded.body), /Unable to decode command/)

    const success = await invoke(handler, { value: 4 })
    assert.equal(success.status, 200)
    assert.deepEqual(success.body, { accepted: 4 })

    const rejected = await invoke(handler, { value: -1 })
    assert.equal(rejected.status, 409)
    assert.deepEqual(rejected.body, { error: { message: "value must be nonnegative" } })
  })

  test("maps query decode failures to 400 and hides projection store errors behind 500", async () => {
    const endpoint = new PlainEndpoint({
      path: "/query",
      request: s.object({ term: s.string }),
      response: s.object({ term: s.string }),
    })
    const controller: QueryController<{ term: string }, { term: string }> = {
      endpoint,
      authGuard: Auth.public(),
      handler: ({ payload }) => Future.resolve<Response, { term: string }>({ term: payload.term }),
    }
    const withReader: WithProjectionReader = (_onError, procedure) => procedure({} as ProjectionReader)
    const sessions = new MemorySessionStore()
    const handler = handleQuery(withReader, {} as Repositories, sessions, controller)

    const decoded = await invoke(handler, { term: 3 })
    assert.equal(decoded.status, 400)
    assert.match(JSON.stringify(decoded.body), /Unable to decode request/)

    const success = await invoke(handler, { term: "notes" })
    assert.equal(success.status, 200)
    assert.deepEqual(success.body, { term: "notes" })

    const unavailableReader: WithProjectionReader = (onError) => Future.reject(onError(new Error("private detail")))
    const unavailable = await invoke(handleQuery(unavailableReader, {} as Repositories, sessions, controller), {
      term: "notes",
    })
    assert.equal(unavailable.status, 500)
    assert.deepEqual(unavailable.body, { error: { message: "Internal Server Error" } })
    assert.equal(JSON.stringify(unavailable.body).includes("private detail"), false)
  })

  test("guards run after decoding: 400 first, then 401 without a session, then the handler sees the actor", async () => {
    const sessions = new MemorySessionStore()
    const token = await sessions.create(new Id<"User">("u-1")).promise((e) => e)
    const endpoint = new PlainEndpoint<{}, { userId: string }>({
      path: "/who",
      request: s.object({}),
      response: s.object({ userId: s.string }),
    })
    const authGuard = Auth.authenticated()
    const controller: QueryController<{}, { userId: string }, GuardResult<typeof authGuard>> = {
      endpoint,
      authGuard,
      handler: ({ auth }) => Future.resolve({ userId: auth.actor.userId.value }),
    }
    const withReader: WithProjectionReader = (_onError, procedure) => procedure({} as ProjectionReader)
    const handler = handleQuery(withReader, {} as Repositories, sessions, controller)
    assert.equal((await invoke(handler, 7)).status, 400)
    assert.deepEqual(await invoke(handler, {}), {
      status: 401,
      body: { error: { message: "Authentication required" } },
      headers: {},
    })
    assert.deepEqual((await invoke(handler, {}, { cookie: "sid=unknown" })).status, 401)
    assert.deepEqual((await invoke(handler, {}, { cookie: `other=1; sid=${token}` })).body, { userId: "u-1" })
  })

  test("a command's session changes reach the reply as Set-Cookie", async () => {
    const sessions = new MemorySessionStore()

    const startEndpoint = new PlainEndpoint<{}, {}>({ path: "/start", request: s.object({}), response: s.object({}) })
    const startAuthGuard = Auth.public()
    const startController: CommandController<{}, {}, GuardResult<typeof startAuthGuard>> = {
      endpoint: startEndpoint,
      authGuard: startAuthGuard,
      handler: ({ session }) =>
        session
          .start(new Id<"User">("u-1"))
          .mapRej((): Response => internalServerError)
          .map(() => ({})),
    }
    const startHandler = handleCommand(
      new MemoryEventDatabase().withEventStore,
      sessions,
      new MemoryLoginCodes(),
      startController
    )
    const started = await invoke(startHandler, {})
    assert.deepEqual(started.headers, { "Set-Cookie": "sid=token-1; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400" })

    const endEndpoint = new PlainEndpoint<{}, {}>({ path: "/end", request: s.object({}), response: s.object({}) })
    const endAuthGuard = Auth.authenticated()
    const endController: CommandController<{}, {}, GuardResult<typeof endAuthGuard>> = {
      endpoint: endEndpoint,
      authGuard: endAuthGuard,
      handler: ({ session }) =>
        session
          .end()
          .mapRej((): Response => internalServerError)
          .map(() => ({})),
    }
    const endHandler = handleCommand(
      new MemoryEventDatabase().withEventStore,
      sessions,
      new MemoryLoginCodes(),
      endController
    )
    const ended = await invoke(endHandler, {}, { cookie: "sid=token-1" })
    assert.equal(sessions.sessions.has("token-1"), false)
    assert.equal(ended.headers["Set-Cookie"], undefined)
  })
})
