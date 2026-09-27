export { controller, handler }

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { type Result } from "@lib/result"
import { type Response } from "@be/lib/router"
import { Id } from "@be/lib/event-sourcing/event"
import { type WithEventStore } from "@be/lib/event-sourcing/store"

import { type Command, type CommandResponse, endpoint } from "@be/domain/ai/command/startAuthorization.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type Route, type Purpose } from "@be/domain/ai/routes"
import { toSetupView } from "@be/domain/ai/views"
import { decideStart } from "@be/domain/ai/decide"
import { begin } from "@be/app/ai/authorize"
import { type Attempt } from "@be/app/ai/attempts"
import { type AiConnections } from "@be/app/ai/connections"
import { AiAuthorizationStarted } from "@be/domain/workspace/events/workspace/aiAuthorizationStarted"
import { pendingStatus, failedStatus } from "@be/domain/ai/command/aiStatus"
import { type AiError, aiInternalError, respondAi, toAiRejection } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

/**
 * Records `AiAuthorizationStarted` for the attempt `begin` reserved, but only while that attempt is still open. An
 * overlapping start can open its own attempt (superseding this one) and record it first; recording this one after
 * it would leave the aggregate pointing at an attempt the table has closed, so neither could connect. The check reads
 * the workspace version before it looks at the attempt, and the emit only commits at that same version: a start that
 * records in between sends this back to check again, and one that opens after the check records after this.
 */
function record(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  withEventStore: WithEventStore,
  route: Route,
  purpose: Purpose,
  attempt: Attempt
): Future<Response, CommandResponse> {
  const reply = (status: CommandResponse["status"]) =>
    withEventStore(aiInternalError, function* (store) {
      const workspace = yield* store.find(Workspace, workspaceId)
      return { attemptId: attempt.attemptId, status, setup: toSetupView(workspace.values.ai, ai.routes) }
    })

  return withEventStore(aiInternalError, function* (store) {
    return (yield* store.find(Workspace, workspaceId)).values.aggregateVersion
  }).chain((version) =>
    ai.attempts
      .find(workspaceId, attempt.attemptId)
      .mapRej(aiInternalError)
      .chain((found) => {
        if (!(found instanceof Just && found.value.state === "pending")) return reply(failedStatus("superseded"))
        return withEventStore<Response, Maybe<CommandResponse>>(aiInternalError, function* (store) {
          const current = yield* store.find(Workspace, workspaceId)
          if (current.values.aggregateVersion !== version) return Nothing()
          yield* store.emit({
            aggregate: Workspace,
            event: new AiAuthorizationStarted({
              type: AiAuthorizationStarted.type,
              aggregateId: workspaceId,
              attemptId: attempt.attemptId,
              provider: route.provider,
              method: route.method,
              purpose,
              expiresAt: attempt.expiresAt,
            }),
          })
          const workspace = yield* store.find(Workspace, workspaceId)
          return Just({
            attemptId: attempt.attemptId,
            status: pendingStatus(attempt),
            setup: toSetupView(workspace.values.ai, ai.routes),
          })
        }).chain((recorded) =>
          recorded instanceof Just
            ? Future.resolve<Response, CommandResponse>(recorded.value)
            : record(ai, workspaceId, withEventStore, route, purpose, attempt)
        )
      })
  )
}

/**
 * Start (or restart) an authorization attempt. `decideStart` runs read-only first, so a purpose that doesn't fit
 * the current setup state (e.g. `initial` with a connection already active) never reaches the adapter. `begin` then
 * runs outside the transaction — it may call a real provider — before `record` writes `AiAuthorizationStarted`, or
 * answers `superseded` when an overlapping start has already replaced the attempt.
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
    .chain((attempt) => record(ai, workspaceId, withEventStore, route, payload.purpose, attempt))
}

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
