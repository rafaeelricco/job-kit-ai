export { type NoteError, toResponse, parseTitle, internalError, respond }

import { Future } from "@lib/future"
import { type Result, Success, Failure } from "@lib/result"
import { json, type Response } from "@be/lib/router"

type NoteError = { type: "not_found" } | { type: "blank_title" }

function toResponse(error: NoteError): Response {
  switch (error.type) {
    case "not_found":
      return json({
        status: 404,
        content: { error: { message: "Note not found" } },
      })
    case "blank_title":
      return json({
        status: 400,
        content: { error: { message: "Title cannot be empty" } },
      })
    default: {
      const _exhaustiveCheck: never = error
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/**
 * Leave the `Result` world at the edge of a handler: a `Failure` becomes a
 * rejected `Future` carrying its HTTP reply, a `Success` resolves.
 *
 * ```ts
 * respond(parseTitle(payload.title)).chain((title) => ...)   // validate first
 * withEventStore(internalError, procedure).chain(respond)    // or unwrap last
 * ```
 */
function respond<T>(result: Result<NoteError, T>): Future<Response, T> {
  return result.either<Future<Response, T>>(
    (error) => Future.reject(toResponse(error)),
    (ok) => Future.resolve(ok)
  )
}

/**
 * Trims a raw title, failing when nothing is left. Shared by every command
 * that accepts a title so the blank-title rule can't drift between them.
 */
function parseTitle(raw: string): Result<NoteError, string> {
  const title = raw.trim()
  return title.length === 0 ? Failure({ type: "blank_title" }) : Success(title)
}

/** Build the 500 response for a command's store failure; `err.message` goes straight to the wire. */
function internalError(err: Error): Response {
  return json({ status: 500, content: { error: { message: err.message } } })
}
