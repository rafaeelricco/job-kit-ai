import { json, type Response } from "@be/lib/router"
import * as s from "@lib/json/schema"
import { Future } from "@lib/future"
import { PlainEndpoint } from "@be/app/endpoint"

/** The generic 500 reply for a query whose store lookup failed; no error details leak to the client. */
export const internalServerError = json({
  status: 500,
  content: { error: { message: "Internal Server Error" } },
})

export function toResponse<Req, Res>(
  endpoint: PlainEndpoint<Req, Res>,
  response: Res,
  headers: Record<string, string> = {}
): Response {
  return json({ headers, content: s.encode(endpoint.response, response) })
}

/**
 * Decode a request body, rejecting with a 400 that says why.
 *
 * ```ts
 * decodeBody(endpoint.request, req.body, "command").chain(handle)
 * // 400 { error: { message: "Unable to decode command: ..." } }
 * ```
 */
export function decodeBody<T>(schema: s.Schema<T>, body: unknown, what: "command" | "request"): Future<Response, T> {
  return s.decode(schema, body).either<Future<Response, T>>(
    (reason) =>
      Future.reject(json({ status: 400, content: { error: { message: `Unable to decode ${what}: ${reason}` } } })),
    (value) => Future.resolve(value)
  )
}
