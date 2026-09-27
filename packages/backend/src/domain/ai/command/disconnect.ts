export { controller, handler }

import { Just } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { type Response } from "@be/lib/router"

import { type Command, type CommandResponse, endpoint } from "@be/domain/ai/command/disconnect.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type AiSetupView, toSetupView } from "@be/domain/ai/views"
import { decideDisconnect } from "@be/domain/ai/decide"
import { Id } from "@be/lib/event-sourcing/event"
import { type AiError, aiInternalError, respondAi, releaseSecrets } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

/** Disconnect the active connection and release its credential. Repeating it once it's gone is a no-op. */
const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({
  payload,
  auth,
  ai,
  withEventStore,
}) => {
  const workspaceId = Workspace.idForOwner(auth.actor.userId)
  return withEventStore<Response, Result<AiError, { setup: AiSetupView; release: Id<"AiSecret">[] }>>(
    aiInternalError,
    function* (store) {
      const workspace = yield* store.find(Workspace, workspaceId)
      const decided = decideDisconnect(workspace.values.ai, workspaceId, payload.connectionId)
      if (decided instanceof Failure) return Failure(decided.error)
      if (!(decided.value instanceof Just)) {
        return Success({ setup: toSetupView(workspace.values.ai, ai.routes), release: [] })
      }
      yield* store.emit({ aggregate: Workspace, event: decided.value.value.event })
      const updated = yield* store.find(Workspace, workspaceId)
      return Success({ setup: toSetupView(updated.values.ai, ai.routes), release: decided.value.value.release })
    }
  )
    .chain(respondAi)
    .chain(({ setup, release }) => releaseSecrets<Response>(ai, workspaceId, release).map(() => ({ setup })))
}

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
