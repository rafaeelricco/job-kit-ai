export { controller, handler }

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { type Response } from "@be/lib/router"

import { type Command, type CommandResponse, endpoint } from "@be/domain/ai/command/testConnection.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type AiState, type Connection, type ConnectionStatus } from "@be/domain/workspace/aggregate/aiState"
import { type Readiness } from "@be/domain/ai/adapter"
import { boundedVerify, VERIFY_TIMEOUT } from "@be/app/ai/authorize"
import { toSetupView } from "@be/domain/ai/views"
import { AiConnectionChecked } from "@be/domain/workspace/events/workspace/aiConnectionChecked"
import { type AiConnections } from "@be/app/ai/connections"
import { Id } from "@be/lib/event-sourcing/event"
import { type AiError, aiInternalError, respondAi } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

function findConnection(ai: AiState, id: Id<"AiConnection">): Result<AiError, Connection> {
  if (ai.active instanceof Just && ai.active.value.connectionId.value === id.value) return Success(ai.active.value)
  if (ai.staged instanceof Just && ai.staged.value.connectionId.value === id.value) return Success(ai.staged.value)
  return Failure({ type: "connection_not_found" })
}

/** `invalid` has no matching `ConnectionStatus` (a credential that never worked isn't something that got "revoked"), so it's folded into `revoked`. */
function toConnectionStatus(readiness: Readiness): ConnectionStatus {
  if (readiness.kind === "ready") return "ready"
  switch (readiness.reason) {
    case "invalid":
    case "revoked":
      return "revoked"
    case "expired":
      return "expired"
    case "quota_exhausted":
      return "quota_exhausted"
    case "unreachable":
      return "unreachable"
    default:
      return readiness.reason satisfies never
  }
}

/** Outside `withEventStore`: a missing secret or adapter is reported directly, a live one goes through the same bounded `verify` `advance` uses. */
function checkStatus(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  connection: Connection
): Future<Response, ConnectionStatus> {
  return ai.vault
    .get(workspaceId, connection.credentialRef)
    .mapRej(aiInternalError)
    .chain((secret): Future<Response, ConnectionStatus> => {
      if (secret instanceof Nothing) return Future.resolve("revoked")
      const route = { provider: connection.provider, method: connection.method }
      const adapter = ai.adapter(route)
      if (adapter instanceof Nothing) return Future.resolve("unreachable")
      return boundedVerify(adapter.value, route, secret.value, VERIFY_TIMEOUT)
        .mapRej(aiInternalError)
        .map(toConnectionStatus)
    })
}

/** Runs one bounded, real `verify` against the connection's current credential and records the result. */
const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({
  payload,
  auth,
  ai,
  withEventStore,
}) => {
  const workspaceId = Workspace.idForOwner(auth.actor.userId)
  return withEventStore<Response, Result<AiError, Connection>>(aiInternalError, function* (store) {
    const workspace = yield* store.find(Workspace, workspaceId)
    return findConnection(workspace.values.ai, payload.connectionId)
  })
    .chain(respondAi)
    .chain((connection) => checkStatus(ai, workspaceId, connection))
    .chain((status) =>
      withEventStore(aiInternalError, function* (store) {
        yield* store.emit({
          aggregate: Workspace,
          event: new AiConnectionChecked({
            type: AiConnectionChecked.type,
            aggregateId: workspaceId,
            connectionId: payload.connectionId,
            status,
          }),
        })
        const workspace = yield* store.find(Workspace, workspaceId)
        return { setup: toSetupView(workspace.values.ai, ai.routes) }
      })
    )
}

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
