export { controller, handler }

import { Just } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { type Response } from "@be/lib/router"

import { type Command, type CommandResponse, endpoint } from "@be/domain/ai/command/confirmSwitch.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type AiSetupView, toSetupView } from "@be/domain/ai/views"
import { decideConfirmSwitch } from "@be/domain/ai/decide"
import { Id } from "@be/lib/event-sourcing/event"
import { type AiError, aiInternalError, respondAi, releaseSecrets } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

/**
 * Confirm a staged switch: it becomes the active connection. The previous active connection's credential is
 * released from the vault only after the event has committed (Q2 in the plan: emit first, delete after, so a
 * failed emit never orphans the still-active connection).
 */
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
      const decided = decideConfirmSwitch(workspace.values.ai, workspaceId, payload.connectionId)
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
