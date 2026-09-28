export { controller, handler }

import { type Response } from "@be/lib/router"
import { type Query, type QueryResponse, endpoint } from "@be/domain/ai/query/getSetup.api"
import { type QueryController, type QueryHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { RepoAiSetups } from "@be/domain/ai/projection/aiSetups"
import { initialAi } from "@be/domain/workspace/aggregate/aiState"
import { toSetupView } from "@be/domain/ai/views"
import { routeViews } from "@be/domain/ai/routes"
import { routeMode } from "@be/app/ai/connections"
import { internalServerError } from "@be/app/responses"

const authGuard = Auth.authenticated()

/**
 * The signed-in user's AI setup: routes, setup progress, and any active or
 * staged connection. A missing document (projection lag right after
 * `WorkspaceProvisioned`) reports the initial, not-yet-connected state.
 */
const handler: QueryHandler<Query, QueryResponse, GuardResult<typeof authGuard>> = ({ auth, projections }) => {
  const workspaceId = Workspace.idForOwner(auth.actor.userId)
  return projections[RepoAiSetups.collectionName]
    .get(workspaceId)
    .mapRej((): Response => internalServerError)
    .map((found) => toSetupView(found.map((doc) => doc.ai).withDefault(initialAi), routeViews(routeMode())))
}

const controller: QueryController<Query, QueryResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
