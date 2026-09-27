export { controller, handler }

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { type Response } from "@be/lib/router"
import { Id } from "@be/lib/event-sourcing/event"
import { type WithEventStore } from "@be/lib/event-sourcing/store"

import {
  type Command,
  type CommandResponse,
  type StepRequest,
  endpoint,
} from "@be/domain/ai/command/advanceAuthorization.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { type AiState } from "@be/domain/workspace/aggregate/aiState"
import { type AuthorizationStatus, type FailureReason, toSetupView } from "@be/domain/ai/views"
import { decideReady } from "@be/domain/ai/decide"
import { advance, type Step, type Advanced } from "@be/app/ai/authorize"
import { type Attempt } from "@be/app/ai/attempts"
import { type AiConnections } from "@be/app/ai/connections"
import { pendingStatus, failedStatus, connectedStatus } from "@be/domain/ai/command/aiStatus"
import { type AiError, aiInternalError, toAiRejection, releaseSecrets } from "@be/domain/ai/command/aiErrors"

const authGuard = Auth.authenticated()

function toStep(step: StepRequest): Step {
  switch (step.kind) {
    case "poll":
      return { kind: "poll" }
    case "secret":
      return { kind: "secret", secret: step.secret }
    case "retry":
      return { kind: "retry" }
    default:
      return step satisfies never
  }
}

/** For an already-`connected` attempt (a stale repeat), find which side of the aggregate its credential ended up on. */
function roleOfConnected(state: AiState, attempt: Attempt): "active" | "staged" {
  if (attempt.credentialRef instanceof Just) {
    const ref = attempt.credentialRef.value
    if (state.active instanceof Just && state.active.value.credentialRef.value === ref.value) return "active"
    if (state.staged instanceof Just && state.staged.value.credentialRef.value === ref.value) return "staged"
  }
  return "active"
}

function withCurrentSetup(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  withEventStore: WithEventStore,
  status: AuthorizationStatus
): Future<Response, CommandResponse> {
  return withEventStore(aiInternalError, function* (store) {
    const workspace = yield* store.find(Workspace, workspaceId)
    return { status, setup: toSetupView(workspace.values.ai, ai.routes) }
  })
}

/**
 * The one branch with real ceremony: a credential just verified `ready`. `decideReady` runs twice — once read-only
 * to catch `superseded`/`different_account` before anything is written, once for real right after this attempt wins
 * the race to claim `connected`. A second run is necessary because a cancel or a fresh `start` can flip the attempt
 * out from under a slow verify at any point up to that claim (`Attempts.settle` only applies while the attempt is
 * still open, so the claim itself is the linearization point — see `app/ai/authorize.ts`).
 */
function settleReady(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  withEventStore: WithEventStore,
  ready: Extract<Advanced, { kind: "ready" }>
): Future<Response, CommandResponse> {
  const { attempt, credentialRef, readiness } = ready
  const connectionId = Id.random<"AiConnection">()

  const dryRun = withEventStore<
    Response,
    Result<AiError | "superseded" | "different_account", { role: "active" | "staged" }>
  >(aiInternalError, function* (store) {
    const workspace = yield* store.find(Workspace, workspaceId)
    const decided = decideReady(workspace.values.ai, attempt, credentialRef, readiness, connectionId)
    return decided instanceof Failure ? Failure(decided.error) : Success({ role: decided.value.role })
  })

  return dryRun.chain((decided) => {
    if (decided instanceof Failure) {
      if (decided.error === "different_account") {
        return ai.attempts
          .settle(workspaceId, attempt.attemptId, {
            state: "verification_failed",
            failure: Just("different_account"),
            credentialRef: Nothing(),
          })
          .mapRej(aiInternalError)
          .chain(() => releaseSecrets(ai, workspaceId, [credentialRef]))
          .chain(() => withCurrentSetup(ai, workspaceId, withEventStore, failedStatus("different_account")))
      }
      // "superseded", or (in practice unreachable, since every purpose is handled explicitly) a plain `AiError`.
      return ai.attempts
        .settle(workspaceId, attempt.attemptId, {
          state: "superseded",
          failure: Just("superseded"),
          credentialRef: Nothing(),
        })
        .mapRej(aiInternalError)
        .chain(() => releaseSecrets(ai, workspaceId, [credentialRef]))
        .chain(() => withCurrentSetup(ai, workspaceId, withEventStore, failedStatus("superseded")))
    }

    return ai.attempts
      .settle(workspaceId, attempt.attemptId, {
        state: "connected",
        failure: Nothing(),
        credentialRef: Just(credentialRef),
      })
      .mapRej(aiInternalError)
      .chain((won) => {
        if (!won) {
          return releaseSecrets<Response>(ai, workspaceId, [credentialRef]).chain(() =>
            ai.attempts
              .find(workspaceId, attempt.attemptId)
              .mapRej(aiInternalError)
              .chain((found) => {
                const reason: FailureReason =
                  found instanceof Just && found.value.failure instanceof Just
                    ? found.value.failure.value
                    : "superseded"
                return withCurrentSetup(ai, workspaceId, withEventStore, failedStatus(reason))
              })
          )
        }

        return withEventStore<
          Response,
          Result<AiError | "superseded" | "different_account", { release: Id<"AiSecret">[]; role: "active" | "staged" }>
        >(aiInternalError, function* (store) {
          const workspace = yield* store.find(Workspace, workspaceId)
          const redecided = decideReady(workspace.values.ai, attempt, credentialRef, readiness, connectionId)
          if (redecided instanceof Failure) return Failure(redecided.error)
          yield* store.emit({ aggregate: Workspace, event: redecided.value.event })
          return Success({ release: redecided.value.release, role: redecided.value.role })
        }).chain((finalDecision) => {
          if (finalDecision instanceof Failure) {
            return releaseSecrets<Response>(ai, workspaceId, [credentialRef]).chain(() =>
              withCurrentSetup(ai, workspaceId, withEventStore, failedStatus("superseded"))
            )
          }
          return releaseSecrets<Response>(ai, workspaceId, finalDecision.value.release).chain(() =>
            withCurrentSetup(ai, workspaceId, withEventStore, connectedStatus(finalDecision.value.role))
          )
        })
      })
  })
}

/**
 * Advance one step of an in-flight attempt. Every outcome but `ready` is a direct status report; `ready` is the
 * moment a credential might actually become a connection, handled by `settleReady`.
 */
const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({
  payload,
  auth,
  ai,
  withEventStore,
}) => {
  const workspaceId = Workspace.idForOwner(auth.actor.userId)

  return advance(ai, workspaceId, payload.attemptId, toStep(payload.step))
    .mapRej(toAiRejection)
    .chain((advanced): Future<Response, CommandResponse> => {
      switch (advanced.kind) {
        case "pending":
          return withCurrentSetup(ai, workspaceId, withEventStore, pendingStatus(advanced.attempt))
        case "failed":
          return withCurrentSetup(ai, workspaceId, withEventStore, failedStatus(advanced.reason))
        case "connected":
          return withEventStore(aiInternalError, function* (store) {
            const workspace = yield* store.find(Workspace, workspaceId)
            return {
              status: connectedStatus(roleOfConnected(workspace.values.ai, advanced.attempt)),
              setup: toSetupView(workspace.values.ai, ai.routes),
            }
          })
        case "ready":
          return settleReady(ai, workspaceId, withEventStore, advanced)
        default:
          return advanced satisfies never
      }
    })
}

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
