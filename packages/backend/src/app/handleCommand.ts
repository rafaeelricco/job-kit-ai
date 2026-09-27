export { handleCommand }
export type { CommandController, CommandHandler } from "@be/app/handlers"

import * as express from "express"
import { route } from "@be/lib/router"
import { toResponse, decodeBody } from "@be/app/responses"
import { type WithEventStore } from "@be/lib/event-sourcing/store"
import { type CommandController } from "@be/app/handlers"
import { type AuthGuardResult } from "@be/app/auth/policy"
import { guardRequest } from "@be/app/resolveAuth"
import { type SessionStore, Session, sessionToken } from "@be/app/session"
import { type LoginCodes } from "@be/app/loginCodes"

/**
 * Turn a `CommandController` into an Express handler: decode the body (400),
 * run the auth guard (401/403), run the handler against the event store, and
 * encode the response with any `Set-Cookie` the handler's session produced.
 */
function handleCommand<Command, Res, Result extends AuthGuardResult>(
  withEventStore: WithEventStore,
  sessions: SessionStore,
  loginCodes: LoginCodes,
  { endpoint, authGuard, handler }: CommandController<Command, Res, Result>
): express.Handler {
  return route((req) =>
    decodeBody(endpoint.request, req.body, "command").chain((command) =>
      guardRequest(req, sessions, authGuard).chain(({ actor, auth }) => {
        const session = new Session(sessions, sessionToken(req))
        return handler({ payload: command, actor, auth, session, loginCodes, withEventStore }).map((res) =>
          toResponse(endpoint, res, session.headers)
        )
      })
    )
  )
}
