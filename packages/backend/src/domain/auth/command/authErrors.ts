export { type AuthError, respond, parseEmail }

import { Future } from "@lib/future"
import { type Result, Success, Failure } from "@lib/result"
import { json, type Response } from "@be/lib/router"

/** Everything an auth command can refuse; `toResponse` maps each to its HTTP reply. */
type AuthError = { type: "invalid_email" } | { type: "invalid_code" }

/** `invalid_code` deliberately covers wrong, expired, used and locked-out codes alike. */
function toResponse(error: AuthError): Response {
  switch (error.type) {
    case "invalid_email":
      return json({ status: 400, content: { error: { message: "Enter a valid email address" } } })
    case "invalid_code":
      return json({ status: 401, content: { error: { message: "That code is invalid or has expired" } } })
    default: {
      const _exhaustiveCheck: never = error
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/** Leave the `Result` world at the edge of a handler, as `aiErrors.respondAi` does. */
function respond<T>(result: Result<AuthError, T>): Future<Response, T> {
  return result.either<Future<Response, T>>(
    (error) => Future.reject(toResponse(error)),
    (ok) => Future.resolve(ok)
  )
}

/** Trim and lowercase, so `A@x.io ` and `a@x.io` are one account (see `User.idForEmail`). */
function parseEmail(raw: string): Result<AuthError, string> {
  const email = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(email) ? Success(email) : Failure({ type: "invalid_email" })
}
