export { type AiError, toResponse, respondAi, aiInternalError, toAiRejection, releaseSecrets }

import { Future } from "@lib/future"
import { type Result } from "@lib/result"
import { json, type Response } from "@be/lib/router"

import { Id } from "@be/lib/event-sourcing/event"
import { internalServerError } from "@be/app/responses"
import { type AiConnections } from "@be/app/ai/connections"
import { type PreferenceError } from "@be/domain/ai/capabilities"

/**
 * `aiInternalError` never forwards `err.message` to the wire. Adapter and vault failures can carry provider
 * response bodies or crypto details that must never reach the client (see `domain/ai/adapter.ts`'s doc comment).
 */
type AiError =
  | { type: "route_not_ready" } // 409: the route isn't offered, or has no adapter behind it yet
  | { type: "invalid_purpose" } // 409: e.g. "initial" while a connection is already active
  | { type: "attempt_not_found" } // 404: including another workspace's attempt
  | { type: "invalid_step" } // 400: a step that doesn't match the attempt's method or state
  | { type: "connection_not_found" } // 404
  | { type: "not_ready" } // 409: completing the "connect" setup step without a ready connection
  | { type: "preference_not_allowed"; reason: PreferenceError } // 422

function toResponse(error: AiError): Response {
  switch (error.type) {
    case "route_not_ready":
      return json({ status: 409, content: { error: { message: "This route isn't available yet" } } })
    case "invalid_purpose":
      return json({
        status: 409,
        content: { error: { message: "That purpose doesn't apply to the current setup state" } },
      })
    case "attempt_not_found":
      return json({ status: 404, content: { error: { message: "Authorization attempt not found" } } })
    case "invalid_step":
      return json({ status: 400, content: { error: { message: "That step doesn't apply to this attempt" } } })
    case "connection_not_found":
      return json({ status: 404, content: { error: { message: "Connection not found" } } })
    case "not_ready":
      return json({ status: 409, content: { error: { message: "No ready connection to complete setup with" } } })
    case "preference_not_allowed":
      return json({ status: 422, content: { error: { message: `Preference not allowed: ${error.reason}` } } })
    default: {
      const _exhaustiveCheck: never = error
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

/**
 * Leave the `Result` world at the edge of a handler: a `Failure` becomes a rejected `Future` carrying its HTTP
 * reply, a `Success` resolves.
 */
function respondAi<T>(result: Result<AiError, T>): Future<Response, T> {
  return result.either<Future<Response, T>>(
    (error) => Future.reject(toResponse(error)),
    (ok) => Future.resolve(ok)
  )
}

/** Build the 500 response for a command's store failure. `err.message` never reaches the wire. */
function aiInternalError(_err: Error): Response {
  return internalServerError
}

/** `app/ai/authorize.ts`'s `begin`/`advance` reject with `AiError | Error`; this is the one place that collapses both into a `Response`. */
function toAiRejection(error: AiError | Error): Response {
  return error instanceof Error ? aiInternalError(error) : toResponse(error)
}

/**
 * Best-effort secret cleanup that runs after an emit has already committed: rolling that emit back because cleanup
 * failed would be worse than a stray sealed row. A failed remove is logged by ref only — never the secret — and
 * never fails the command. Generic in `E` (rather than `never`) so it composes with `.chain` in whatever error
 * channel the caller is already in, since `Future.chain` fixes `E` from its receiver.
 */
function releaseSecrets<E>(ai: AiConnections, workspaceId: Id<"Workspace">, refs: Id<"AiSecret">[]): Future<E, void> {
  if (refs.length === 0) return Future.resolve(undefined)
  return ai.vault.remove(workspaceId, refs).chainRej((): Future<E, void> => {
    console.error(`Failed to remove AI secret(s): ${refs.map((ref) => ref.value).join(", ")}`)
    return Future.resolve(undefined)
  })
}
