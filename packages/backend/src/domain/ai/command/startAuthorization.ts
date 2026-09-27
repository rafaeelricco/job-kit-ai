export { controller, handler }

import { type Result } from "@lib/result"
import { type Response } from "@be/lib/router"

import { type Command, type CommandResponse, endpoint } from "@be/domain/ai/command/startAuthorization.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type Route } from "@be/domain/ai/routes"
import { toSetupView } from "@be/domain/ai/views"
import { decideStart } from "@be/domain/ai/decide"
import { begin } from "@be/app/ai/authorize"
import { AiAuthorizationStarted } from "@be/domain/workspace/events/workspace/aiAuthorizationStarted"
import { pendingStatus } from "@be/domain/ai/command/aiStatus"
import { type AiError, aiInternalError, respondAi, toAiRejection } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

/**
 * Start (or restart) an authorization attempt. `decideStart` runs read-only first, so a purpose that doesn't fit
 * the current setup state (e.g. `initial` with a connection already active) never reaches the adapter. `begin` then
 * runs outside the transaction — it may call a real provider — before `AiAuthorizationStarted` is recorded.
 */
const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({
  payload,
  auth,
  ai,
  withEventStore,
}) => {
  const workspaceId = Workspace.idForOwner(auth.actor.userId)
  const route: Route = { provider: payload.provider, method: payload.method }

  return withEventStore<Response, Result<AiError, void>>(aiInternalError, function* (store) {
    const workspace = yield* store.find(Workspace, workspaceId)
    return decideStart(workspace.values.ai, route, payload.purpose)
  })
    .chain(respondAi)
    .chain(() => begin(ai, workspaceId, route, payload.purpose).mapRej(toAiRejection))
    .chain((attempt) =>
      withEventStore(aiInternalError, function* (store) {
        yield* store.emit({
          aggregate: Workspace,
          event: new AiAuthorizationStarted({
            type: AiAuthorizationStarted.type,
            aggregateId: workspaceId,
            attemptId: attempt.attemptId,
            provider: route.provider,
            method: route.method,
            purpose: payload.purpose,
            expiresAt: attempt.expiresAt,
          }),
        })
        const workspace = yield* store.find(Workspace, workspaceId)
        return {
          attemptId: attempt.attemptId,
          status: pendingStatus(attempt),
          setup: toSetupView(workspace.values.ai, ai.routes),
        }
      })
    )
}

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
