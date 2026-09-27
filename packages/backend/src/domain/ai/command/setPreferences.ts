export { controller, handler }

import { Just } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { type Response } from "@be/lib/router"

import { type Command, type CommandResponse, endpoint } from "@be/domain/ai/command/setPreferences.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { toSetupView } from "@be/domain/ai/views"
import { decidePreferences } from "@be/domain/ai/decide"
import { type AiError, aiInternalError, respondAi } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

/** Save preferences on the active connection. `checkPreferences` is the only gate — applied here whatever the UI sent. */
const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({
  payload,
  auth,
  ai,
  withEventStore,
}) => {
  const workspaceId = Workspace.idForOwner(auth.actor.userId)
  return withEventStore<Response, Result<AiError, CommandResponse>>(aiInternalError, function* (store) {
    const workspace = yield* store.find(Workspace, workspaceId)
    const decided = decidePreferences(workspace.values.ai, workspaceId, payload.connectionId, {
      model: payload.model,
      effort: payload.effort,
    })
    if (decided instanceof Failure) return Failure(decided.error)
    if (!(decided.value instanceof Just)) return Success({ setup: toSetupView(workspace.values.ai, ai.routes) })
    yield* store.emit({ aggregate: Workspace, event: decided.value.value })
    const updated = yield* store.find(Workspace, workspaceId)
    return Success({ setup: toSetupView(updated.values.ai, ai.routes) })
  }).chain(respondAi)
}

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
