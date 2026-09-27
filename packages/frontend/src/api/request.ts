export { call, fetchErrorToString, type FetchError, NetworkError, BadStatus, UnableToDecode }

import * as s from "@lib/json/schema"
import { Future } from "@lib/future"
import { type Json } from "@lib/json/types"

class NetworkError {
  declare private readonly _tag: "NetworkError"
  readonly reason: string
  constructor(reason: string) {
    this.reason = reason
  }
}

/** A non-2xx reply. `message` is the server's `{ error: { message } }`, else the status text. */
class BadStatus {
  declare private readonly _tag: "BadStatus"
  readonly status: number
  readonly message: string
  constructor(status: number, message: string) {
    this.status = status
    this.message = message
  }
}

class UnableToDecode {
  declare private readonly _tag: "UnableToDecode"
  readonly reason: string
  constructor(reason: string) {
    this.reason = reason
  }
}

type FetchError = NetworkError | BadStatus | UnableToDecode

/** Structural, so `call` needs nothing from `@be`; the server's `PlainEndpoint` satisfies it. */
type Endpoint<Req, Res> = { readonly path: string; readonly request: s.Schema<Req>; readonly response: s.Schema<Res> }

/** What came back, before any decoding; a union so an "ok" reply can't carry a failure status. */
type Reply = { type: "Ok"; body: string } | { type: "BadStatus"; status: number; statusText: string; body: string }

const schema_errorBody = s.stringified(s.object({ error: s.object({ message: s.string }) }))

/** POST `body` to `endpoint` with the session cookie, decoding the reply with the endpoint's own schema. */
function call<Req, Res>(endpoint: Endpoint<Req, Res>, body: Req): Future<FetchError, Res> {
  return send(endpoint.path, s.encode(endpoint.request, body)).chain((reply): Future<FetchError, Res> => {
    switch (reply.type) {
      case "Ok":
        return s.decode(s.stringified(endpoint.response), reply.body).either<Future<FetchError, Res>>(
          (reason) => Future.reject(new UnableToDecode(reason)),
          (value) => Future.resolve(value)
        )
      case "BadStatus":
        return Future.reject(new BadStatus(reply.status, errorMessage(reply)))
      default: {
        const _exhaustiveCheck: never = reply
        throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
      }
    }
  })
}

/** The fetch boundary: the one place a Promise becomes a Future. Cancelling aborts the request. */
function send(path: string, body: Json): Future<FetchError, Reply> {
  return Future.create<FetchError, Reply>((reject, resolve) => {
    const controller = new AbortController()
    fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then((res) =>
        res
          .text()
          .then((text) =>
            resolve(
              res.ok ?
                { type: "Ok", body: text }
              : { type: "BadStatus", status: res.status, statusText: res.statusText, body: text }
            )
          )
      )
      .catch((err: unknown) => {
        // An abort is our own cancel, not a failure anyone is still listening for.
        if (!controller.signal.aborted) reject(new NetworkError(err instanceof Error ? err.message : String(err)))
      })
    return () => controller.abort()
  })
}

function errorMessage(reply: { statusText: string; body: string }): string {
  return s.decode(schema_errorBody, reply.body).either(
    () => reply.statusText,
    ({ error }) => error.message
  )
}

function fetchErrorToString(error: FetchError): string {
  switch (true) {
    case error instanceof NetworkError:
      return `Can't reach the server: ${error.reason}`
    case error instanceof BadStatus:
      return error.message
    case error instanceof UnableToDecode:
      return `Unexpected server response: ${error.reason}`
    default:
      return error satisfies never
  }
}
