export { begin, advance, type Step, type Advanced }

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { POSIX, type Duration } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"
import { type Route, type Purpose } from "@be/domain/ai/routes"
import { type Secret, type Readiness, type Authorization, type ProviderAdapter } from "@be/domain/ai/adapter"
import { type FailureReason } from "@be/domain/ai/views"
import { type Attempt } from "@be/app/ai/store/attempts"
import { type AiConnections } from "@be/app/ai/connections"
import { boundedVerify, resolveCredential, logAdapterFailure, VERIFY_TIMEOUT } from "@be/app/ai/credential"
import { type AiError } from "@be/domain/ai/command/aiErrors"

type ReadyReadiness = Extract<Readiness, { kind: "ready" }>

type Step = { kind: "poll" } | { kind: "secret"; secret: string } | { kind: "retry" }

type Advanced =
  | { kind: "pending"; attempt: Attempt }
  | { kind: "failed"; attempt: Attempt; reason: FailureReason }
  | { kind: "ready"; attempt: Attempt; credentialRef: Id<"AiSecret">; readiness: ReadyReadiness }
  | { kind: "connected"; attempt: Attempt }

/** What every step of one claimed attempt needs; the adapter is looked up once the attempt is known to be live. */
type Ctx = {
  readonly ai: AiConnections
  readonly workspaceId: Id<"Workspace">
  readonly attempt: Attempt
  readonly timeout: Duration
}

const route = (attempt: Attempt): Route => ({ provider: attempt.provider, method: attempt.method })

function widen<T>(f: Future<Error, T>): Future<AiError | Error, T> {
  return f.mapRej((e): AiError | Error => e)
}

function begin(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  chosen: Route,
  purpose: Purpose
): Future<AiError | Error, Attempt> {
  const routeView = ai.routes.find((r) => r.provider === chosen.provider && r.method === chosen.method)
  const adapter = ai.adapter(chosen)
  if (routeView === undefined || routeView.availability === "unproven" || adapter instanceof Nothing) {
    return Future.reject<AiError | Error, Attempt>({ type: "route_not_ready" })
  }

  const attemptId = Id.random<"AiAttempt">()
  return widen(
    adapter.value.begin(chosen, attemptId).chain(({ challenge, expiresAt, secret }) =>
      putIfPresent(ai, workspaceId, secret).chain((secretRef) => {
        const attempt: Attempt = {
          attemptId,
          workspaceId,
          provider: chosen.provider,
          method: chosen.method,
          purpose,
          state: "pending",
          failure: Nothing(),
          challenge,
          secretRef,
          credentialRef: Nothing(),
          expiresAt,
        }
        return ai.attempts
          .open(attempt)
          .chain((superseded) => ai.vault.remove(workspaceId, superseded).map(() => attempt))
      })
    )
  )
}

function putIfPresent(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  secret: Maybe<Secret>
): Future<Error, Maybe<Id<"AiSecret">>> {
  return secret instanceof Just
    ? ai.vault.put(workspaceId, secret.value).map((ref) => Just(ref))
    : Future.resolve(Nothing())
}

function advance(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attemptId: Id<"AiAttempt">,
  step: Step,
  timeout: Duration = VERIFY_TIMEOUT
): Future<AiError | Error, Advanced> {
  return widen(ai.attempts.claim(workspaceId, attemptId)).chain((claimed) =>
    claimed instanceof Nothing
      ? converge(ai, workspaceId, attemptId)
      : handleClaimed(ai, workspaceId, claimed.value, step, timeout)
  )
}

function converge(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attemptId: Id<"AiAttempt">
): Future<AiError | Error, Advanced> {
  return widen(ai.attempts.find(workspaceId, attemptId)).chain((found) => {
    if (found instanceof Nothing) return Future.reject<AiError | Error, Advanced>({ type: "attempt_not_found" })
    const attempt = found.value
    switch (attempt.state) {
      case "pending":
        return Future.resolve<AiError | Error, Advanced>({ kind: "pending", attempt })
      case "verification_failed":
        return Future.resolve<AiError | Error, Advanced>({
          kind: "failed",
          attempt,
          reason: attempt.failure.expect("a verification_failed attempt must carry a failure reason"),
        })
      case "connected":
        return Future.resolve<AiError | Error, Advanced>({ kind: "connected", attempt })
      case "denied":
      case "expired":
      case "cancelled":
      case "superseded":
        return Future.resolve<AiError | Error, Advanced>({ kind: "failed", attempt, reason: attempt.state })
      default:
        return attempt.state satisfies never
    }
  })
}

function handleClaimed(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  step: Step,
  timeout: Duration
): Future<AiError | Error, Advanced> {
  const ctx: Ctx = { ai, workspaceId, attempt, timeout }
  if (attempt.state === "pending" && !attempt.expiresAt.isAfter(POSIX.now())) {
    return widen(settleTerminal(ctx, "expired"))
  }

  if (attempt.state === "verification_failed" && step.kind !== "retry") {
    return widen(releaseLease(ctx)).map((): Advanced => ({
      kind: "failed",
      attempt,
      reason: attempt.failure.withDefault("unreachable"),
    }))
  }

  const adapter = ai.adapter(route(attempt))
  if (adapter instanceof Nothing) {
    return widen(releaseLease(ctx)).chain(() => Future.reject<AiError | Error, Advanced>({ type: "route_not_ready" }))
  }

  return dispatchStep(ctx, adapter.value, step)
}

function dispatchStep(ctx: Ctx, adapter: ProviderAdapter, step: Step): Future<AiError | Error, Advanced> {
  const { attempt } = ctx
  switch (step.kind) {
    case "retry":
      return attempt.state === "verification_failed" && attempt.credentialRef instanceof Just
        ? widen(verifyCredential(ctx, adapter, attempt.credentialRef.value))
        : invalidStep(ctx)
    case "poll":
      return attempt.method === "device" ? widen(pollDevice(ctx, adapter)) : invalidStep(ctx)
    case "secret":
      return dispatchSecret(ctx, adapter, step)
    default:
      return step satisfies never
  }
}

function dispatchSecret(
  ctx: Ctx,
  adapter: ProviderAdapter,
  step: Extract<Step, { kind: "secret" }>
): Future<AiError | Error, Advanced> {
  const { attempt } = ctx
  if (attempt.method !== "setup_token" && attempt.method !== "api_key") return invalidStep(ctx)
  return widen(
    releasingOnFailure(ctx, (r) => adapter.accept(r, step.secret)).chain((credential) =>
      afterAuthorized(ctx, adapter, credential)
    )
  )
}

function pollDevice(ctx: Ctx, adapter: ProviderAdapter): Future<Error, Advanced> {
  const { ai, workspaceId, attempt } = ctx
  if (attempt.secretRef instanceof Nothing) return handleAuthorization(ctx, adapter, { kind: "expired" })
  return ai.vault
    .get(workspaceId, attempt.secretRef.value)
    .chain((secret) =>
      secret instanceof Nothing
        ? handleAuthorization(ctx, adapter, { kind: "expired" })
        : releasingOnFailure(ctx, (r) => adapter.poll(r, secret.value)).chain((auth) =>
            handleAuthorization(ctx, adapter, auth)
          )
    )
}

function handleAuthorization(ctx: Ctx, adapter: ProviderAdapter, auth: Authorization): Future<Error, Advanced> {
  switch (auth.kind) {
    case "pending":
      return releaseToPending(ctx)
    case "denied":
      return settleTerminal(ctx, "denied")
    case "expired":
      return settleTerminal(ctx, "expired")
    case "authorized":
      return afterAuthorized(ctx, adapter, auth.credential)
    default:
      return auth satisfies never
  }
}

function afterAuthorized(ctx: Ctx, adapter: ProviderAdapter, credential: Secret): Future<Error, Advanced> {
  const { ai, workspaceId } = ctx
  return ai.vault
    .put(workspaceId, credential)
    .chain((ref) => removeDeviceSecret(ctx).chain(() => verifyCredential(ctx, adapter, ref)))
}

function removeDeviceSecret(ctx: Ctx): Future<Error, void> {
  const { ai, workspaceId, attempt } = ctx
  return attempt.secretRef instanceof Just
    ? ai.vault.remove(workspaceId, [attempt.secretRef.value])
    : Future.resolve(undefined)
}

function verifyCredential(ctx: Ctx, adapter: ProviderAdapter, ref: Id<"AiSecret">): Future<Error, Advanced> {
  const { ai, workspaceId, attempt, timeout } = ctx
  return resolveCredential(ai, workspaceId, adapter, route(attempt), ref).chain((resolved) => {
    switch (resolved.kind) {
      case "missing":
        return settleVerificationFailed(ctx, ref, "revoked")
      case "settled":
        return settleVerificationFailed(ctx, ref, resolved.reason)
      case "stored":
        return boundedVerify(adapter, route(attempt), resolved.secret, timeout).chain((readiness) =>
          readiness.kind === "ready"
            ? Future.resolve<Error, Advanced>({ kind: "ready", attempt, credentialRef: ref, readiness })
            : settleVerificationFailed(ctx, ref, readiness.reason)
        )
      default:
        return resolved satisfies never
    }
  })
}

function settleVerificationFailed(ctx: Ctx, ref: Id<"AiSecret">, reason: FailureReason): Future<Error, Advanced> {
  const { ai, workspaceId, attempt } = ctx
  return ai.attempts
    .settle(workspaceId, attempt.attemptId, {
      state: "verification_failed",
      failure: Just(reason),
      credentialRef: Just(ref),
    })
    .chain((kept) => (kept ? Future.resolve<Error, void>(undefined) : ai.vault.remove(workspaceId, [ref])))
    .map((): Advanced => ({ kind: "failed", attempt, reason }))
}

function settleTerminal(ctx: Ctx, reason: "denied" | "expired"): Future<Error, Advanced> {
  const { ai, workspaceId, attempt } = ctx
  return ai.attempts
    .settle(workspaceId, attempt.attemptId, { state: reason, failure: Just(reason), credentialRef: Nothing() })
    .chain((closed) => (closed ? removeDeviceSecret(ctx) : Future.resolve<Error, void>(undefined)))
    .map((): Advanced => ({ kind: "failed", attempt, reason }))
}

function releaseToPending(ctx: Ctx): Future<Error, Advanced> {
  const { ai, workspaceId, attempt } = ctx
  return ai.attempts
    .settle(workspaceId, attempt.attemptId, {
      state: "pending",
      failure: Nothing(),
      credentialRef: attempt.credentialRef,
    })
    .map((): Advanced => ({ kind: "pending", attempt }))
}

function releaseLease(ctx: Ctx): Future<Error, boolean> {
  const { ai, workspaceId, attempt } = ctx
  return ai.attempts.settle(workspaceId, attempt.attemptId, {
    state: attempt.state,
    failure: attempt.failure,
    credentialRef: attempt.credentialRef,
  })
}

function invalidStep(ctx: Ctx): Future<AiError | Error, Advanced> {
  return widen(releaseLease(ctx)).chain(() => Future.reject<AiError | Error, Advanced>({ type: "invalid_step" }))
}

function releasingOnFailure<T>(ctx: Ctx, call: (r: Route) => Future<Error, T>): Future<Error, T> {
  const { attempt } = ctx
  const r = route(attempt)
  return call(r).chainRej((error) => {
    logAdapterFailure(attempt.method, r, error)
    return releaseLease(ctx).chain(() => Future.reject<Error, T>(error))
  })
}
