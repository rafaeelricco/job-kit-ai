export { type AuthContext, resolveAuth, guardRequest }

import { type Request } from "express"
import { Future } from "@lib/future"
import { json, type Response } from "@be/lib/router"
import { type Actor } from "@be/app/actor"
import { type AuthGuard, type AuthGuardResult } from "@be/app/auth/policy"
import { type GrantKey } from "@be/app/auth/grants"
import { type SessionStore, sessionToken } from "@be/app/session"
import { internalServerError } from "@be/app/responses"

/**
 * The resolved authorization context for a request, built before any guard
 * runs. Exposes privileges (scoped grant keys, so `system:X` never satisfies
 * `session:X`), never roles, so a guard cannot contradict the
 * role → privilege mapping.
 */
type AuthContext = { actor: Actor; privileges: GrantKey[] }

const anonymous: AuthContext = { actor: { type: "Anonymous" }, privileges: [] }

/**
 * No cookie, or an unknown or expired token, is anonymous. No role grants a
 * privilege yet, so a signed-in user carries none.
 */
function resolveAuth(req: Request, sessions: SessionStore): Future<Error, AuthContext> {
  return sessionToken(req).maybe(Future.resolve<Error, AuthContext>(anonymous), (token) =>
    sessions
      .find(token)
      .map((userId) =>
        userId.maybe(anonymous, (id): AuthContext => ({ actor: { type: "User", userId: id }, privileges: [] }))
      )
  )
}

/** The allow branch of a guard's result: what the handler may assume was proven. */
type Allowed<R extends AuthGuardResult> = Extract<R, { result: "allow" }>

function isAllowed<R extends AuthGuardResult>(r: R): r is Allowed<R> {
  return r.result === "allow"
}

/** The guard's denial as an HTTP reply. The trailing 403 is unreachable today (only denials get here) and fails closed. */
function denyResponse(r: AuthGuardResult): Response {
  if (r.result === "deny") return json({ status: r.status, content: { error: { message: r.message } } })
  return json({ status: 403, content: { error: { message: "Forbidden" } } })
}

/**
 * The auth step every command and query runs between decoding the body and
 * calling its handler. It resolves the request's session into an
 * {@link AuthContext}, asks the controller's `authGuard` for a decision, and
 * either lets the request through or rejects with the HTTP reply to send:
 *
 * - allow → resolves `{ actor, auth }`, where `auth` is the guard's allow branch
 *   (e.g. the `Authorized<K>` proof `Auth.system` mints), typed so the handler
 *   receives exactly the proof its guard can produce and nothing more.
 * - deny → rejects with the guard's own 401 (no session) or 403 (no privilege).
 * - session-store failure → rejects with the generic 500; the store's error
 *   never reaches the client.
 *
 * ```ts
 * guardRequest(req, sessions, Auth.authenticated()).chain(({ actor, auth }) =>
 *   handler({ payload, actor, auth, ... })   // auth.actor is a UserActor here
 * )
 * ```
 */
function guardRequest<R extends AuthGuardResult>(
  req: Request,
  sessions: SessionStore,
  authGuard: AuthGuard<R>
): Future<Response, { actor: Actor; auth: Allowed<R> }> {
  return resolveAuth(req, sessions)
    .mapRej((): Response => internalServerError)
    .chain((context) => {
      const r = authGuard(context)
      return isAllowed(r) ? Future.resolve({ actor: context.actor, auth: r }) : Future.reject(denyResponse(r))
    })
}
