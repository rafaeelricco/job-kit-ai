export {
  type Response,
  type Request,
  type Route,
  type Middleware,
  type JSON,
  type SSE,
  type SendMessage,
  type OnError,
  route,
  middleware,
  redirect,
  render,
  json,
  sse,
}

import type * as express from "express"

import { Future } from "@lib/future"
import { type Json } from "@lib/json/types"

/**
 * A library for making express.js routes pure.
 *
 * A route handler is a function that takes a request and a request
 * environment and returns a response. Middlewares transform the environment.
 * A route resolves with a success response or rejects with a failure response.
 */
type Route<T> = (req: express.Request, env: T) => Future<Response, Response>

type Request = express.Request
type Headers = Record<string, string>

type JsonValues = { status: number; headers: Headers; content: Json }
type RedirectValues = { path: string }
type RenderValues = {
  status: number
  headers: Headers
  content: string | Json
}
type SSEValues = {
  headers: Headers
  stream: (emit: SendMessage, onError: OnError) => Future<Error, null>
}

class JSON {
  readonly values: JsonValues
  constructor(values: JsonValues) {
    this.values = values
  }
}

class Redirect {
  readonly values: RedirectValues
  constructor(values: RedirectValues) {
    this.values = values
  }
}

class Render {
  readonly values: RenderValues
  constructor(values: RenderValues) {
    this.values = values
  }
}

/**
 * Server-Sent Events response for real-time streaming to clients.
 * Keeps connection alive and allows server to push updates continuously.
 */
class SSE {
  readonly values: SSEValues
  constructor(values: SSEValues) {
    this.values = values
  }
}

/** Push one message down an open SSE stream; `false` means the connection already closed. */
type SendMessage = (json: Json) => boolean
/** Register a handler to run if the underlying stream I/O fails. */
type OnError = (handler: (err: Error) => void) => void

type Response = Render | JSON | Redirect | SSE

const json = ({
  status = 200,
  headers = {},
  content,
}: {
  status?: number
  headers?: Headers
  content: Json
}): Response => new JSON({ status, headers, content })

const redirect = (path: string): Response => new Redirect({ path })

const render = ({
  status = 200,
  headers = {},
  content,
}: {
  status?: number
  headers?: Headers
  content: string | Json
}): Response => new Render({ status, headers, content })

/**
 * Build an SSE `Response`. `stream` pushes messages via `emit` once the
 * connection is open. Resolving the `Future` it returns ends the stream; its
 * cancel function is the cleanup, and runs when the client disconnects.
 *
 * ```ts
 * sse({
 *   stream: (emit, onError) =>
 *     Future.create(() => {
 *       const id = setInterval(() => emit({ tick: Date.now() }), 1000)
 *       onError(() => clearInterval(id))
 *       return () => clearInterval(id)
 *     }),
 * })
 * ```
 */
const sse = ({ headers = {}, stream }: { headers?: Headers; stream: SSEValues["stream"] }): Response =>
  new SSE({ headers, stream })

/** A middleware is something that transforms the environment. */
type Middleware<A, B> = (req: express.Request, env: A) => Future<Response, B>

/** Compose a `Middleware` in front of a `Route`, threading the enriched environment through. */
function middleware<A, B>(fun: Middleware<A, B>, route: Route<B>): Route<A> {
  return (req, env) => fun(req, env).chain((res) => route(req, res))
}

function send(response: Response, res: express.Response): void {
  switch (true) {
    case response instanceof JSON:
      res.status(response.values.status)
      res.set(response.values.headers)
      res.json(response.values.content)
      return
    case response instanceof Render:
      res.status(response.values.status)
      res.set(response.values.headers)
      res.send(response.values.content)
      return
    case response instanceof Redirect:
      res.redirect(response.values.path)
      return
    case response instanceof SSE:
      res.set({
        ...response.values.headers,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      res.flushHeaders()
      streamSSEResponse(res, response.values.stream)
      return
    default:
      response satisfies never
  }
}

function streamSSEResponse(res: express.Response, stream: SSEValues["stream"]): void {
  let connectionClosed = false
  let endStream = (): void => {}
  const closeConnection = (): void => {
    if (connectionClosed) return
    connectionClosed = true
    endStream()
    res.end()
  }
  const errorHandlers: Array<(err: Error) => void> = []
  const handleError = (err: Error): void => {
    if (connectionClosed) return
    errorHandlers.forEach((handler) => handler(err))
    closeConnection()
  }
  res.on("close", closeConnection)
  res.on("error", handleError)
  endStream = stream(
    function emit(payload) {
      if (connectionClosed) return false
      res.write(`data: ${globalThis.JSON.stringify(payload)}\n\n`)
      return true
    },
    function onError(handler) {
      errorHandlers.push(handler)
    }
  ).fork(handleError, closeConnection)
}

/**
 * Create an express route handler from a Route.
 * It expects an empty environment because the environment is
 * ultimately enriched through middlewares.
 *
 * ```ts
 * app.post("/notes", route((req) => decodeBody(endpoint.request, req.body, "command").chain(handler)))
 * ```
 */
function route(routeHandler: Route<{}>): express.Handler {
  return (req, res) =>
    routeHandler(req, {}).fork(
      (r) => send(r, res),
      (r) => send(r, res)
    )
}
