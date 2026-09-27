export { handleQuery }
export type { QueryController, QueryHandler } from "@be/app/handlers"

import * as express from "express"
import { route } from "@be/lib/router"
import { type Repositories, readProjections } from "@be/app/projections"
import { type WithProjectionReader } from "@be/app/projectionStore"
import { toResponse, internalServerError, decodeBody } from "@be/app/responses"
import { type QueryController } from "@be/app/handlers"
import { type AuthGuardResult } from "@be/app/auth/policy"
import { guardRequest } from "@be/app/resolveAuth"
import { type SessionStore } from "@be/app/session"

/** A client never learns why the store failed: every store error becomes the same generic 500. */
const hideStoreError = (_: Error) => internalServerError

/**
 * Turn a `QueryController` into an Express handler: decode the body (400),
 * run the auth guard (401/403), run the handler with a fresh read-only
 * projection view, encode the response.
 */
function handleQuery<Query, Res, Result extends AuthGuardResult>(
  withProjectionReader: WithProjectionReader,
  repositories: Repositories,
  sessions: SessionStore,
  { endpoint, authGuard, handler }: QueryController<Query, Res, Result>
): express.Handler {
  return route((req) =>
    decodeBody(endpoint.request, req.body, "request").chain((query) =>
      guardRequest(req, sessions, authGuard).chain(({ actor, auth }) =>
        withProjectionReader(hideStoreError, (store) =>
          handler({
            payload: query,
            actor,
            auth,
            projections: readProjections(repositories, store),
          }).map((res) => toResponse(endpoint, res))
        )
      )
    )
  )
}
