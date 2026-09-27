export { controller, handler }

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { type Response } from "@be/lib/router"

import { type Command, type CommandResponse, endpoint } from "@be/domain/ai/command/cancelAuthorization.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { toSetupView } from "@be/domain/ai/views"
import { Id } from "@be/lib/event-sourcing/event"
import { type Attempt } from "@be/app/ai/attempts"
import { aiInternalError, toResponse, releaseSecrets } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

/**
 * Cancel an in-flight attempt. No event is emitted and the active connection is never touched — cancelling only
 * ever concerns the attempt row and its own secrets. `settle` ignores the lease (a poll or verify in flight loses
 * the race) but only applies while the attempt is still open, so repeating a cancel is a no-op.
 */
const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({
  payload,
  auth,
  ai,
  withEventStore,
}) => {
  const workspaceId = Workspace.idForOwner(auth.actor.userId)
  return ai.attempts
    .find(workspaceId, payload.attemptId)
    .mapRej(aiInternalError)
    .chain((found): Future<Response, Attempt> =>
      found instanceof Just ? Future.resolve(found.value) : Future.reject(toResponse({ type: "attempt_not_found" }))
    )
    .chain((attempt) =>
      ai.attempts
        .settle(workspaceId, attempt.attemptId, {
          state: "cancelled",
          failure: Just("cancelled"),
          credentialRef: Nothing(),
        })
        .mapRej(aiInternalError)
        .chain((applied) => (applied ? releaseSecrets(ai, workspaceId, refsOf(attempt)) : Future.resolve(undefined)))
    )
    .chain(() =>
      withEventStore(aiInternalError, function* (store) {
        const workspace = yield* store.find(Workspace, workspaceId)
        return { setup: toSetupView(workspace.values.ai, ai.routes) }
      })
    )
}

function refsOf(attempt: Attempt): Id<"AiSecret">[] {
  return [attempt.secretRef, attempt.credentialRef].flatMap((ref) => (ref instanceof Just ? [ref.value] : []))
}

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
