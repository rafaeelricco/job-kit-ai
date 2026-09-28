export { begin, advance, boundedVerify, VERIFY_TIMEOUT, type Step, type Advanced }

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"

import { type Route, type Purpose } from "@be/domain/ai/routes"
import { type Secret, type Readiness, type Authorization, type ProviderAdapter } from "@be/domain/ai/adapter"
import { type FailureReason } from "@be/domain/ai/views"
import { type Attempt } from "@be/app/ai/attempts"
import { type AiConnections } from "@be/app/ai/connections"
import { type AiError } from "@be/domain/ai/command/aiErrors"

/** The `{ kind: "ready" }` half of `Readiness`: the only variant that can ever produce a connection. */
type ReadyReadiness = Extract<Readiness, { kind: "ready" }>

type Step = { kind: "poll" } | { kind: "secret"; secret: string } | { kind: "retry" }

/** `connected` is an already-connected attempt: a repeat request converges here instead of re-verifying. */
type Advanced =
  | { kind: "pending"; attempt: Attempt }
  | { kind: "failed"; attempt: Attempt; reason: FailureReason }
  | { kind: "ready"; attempt: Attempt; credentialRef: Id<"AiSecret">; readiness: ReadyReadiness }
  | { kind: "connected"; attempt: Attempt }

/** Bounds one real request through a provider's `verify`. A provider that never answers becomes `unreachable`. */
const VERIFY_TIMEOUT = Duration.seconds(20)

const route = (attempt: Attempt): Route => ({ provider: attempt.provider, method: attempt.method })

/**
 * Every helper below but `begin`/`advance`/`converge`/`handleClaimed`/`invalidStep` stays purely `Future<Error, _>`
 * internally — none of them ever construct an `AiError` themselves. `widen` lifts one of those `Error`-only Futures
 * into the wider `AiError | Error` channel at the one point each caller needs to return it alongside a real
 * `AiError` rejection (`Future`'s error type is fixed by its receiver through `chain`, so this can't happen lazily).
 */
function widen<T>(f: Future<Error, T>): Future<AiError | Error, T> {
  return f.mapRej((e): AiError | Error => e)
}

/**
 * Start an authorization attempt. The route must be offered (not `unproven`) and have an adapter behind it, else
 * `route_not_ready`. Runs outside `withEventStore`: the command emits `AiAuthorizationStarted` afterward, once this
 * has actually reserved the attempt.
 */
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

/**
 * Advance an attempt by one step. Claims a 30 s lease first, so two concurrent requests for the same attempt
 * converge on a single adapter call — the loser sees `Nothing` from `claim` and reports the attempt's current state
 * instead of repeating the work.
 */
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

/** No lease was granted: either another request holds it (mid-verify), or the attempt is no longer open. Either way, report its current state rather than doing anything. */
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
      case "authorized":
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

/** The lease is held for the rest of this function: settling (or explicitly releasing) it is every branch's job. */
function handleClaimed(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  step: Step,
  timeout: Duration
): Future<AiError | Error, Advanced> {
  if (attempt.state === "pending" && !attempt.expiresAt.isAfter(POSIX.now())) {
    return widen(settleTerminal(ai, workspaceId, attempt, "expired"))
  }

  if (attempt.state === "verification_failed" && step.kind !== "retry") {
    // A failed verify stays reported until the user retries it: repeated advances must not reset it to pending or
    // store a second copy of the credential.
    return widen(releaseLease(ai, workspaceId, attempt)).map((): Advanced => ({
      kind: "failed",
      attempt,
      reason: attempt.failure.withDefault("unreachable"),
    }))
  }

  const adapter = ai.adapter(route(attempt))
  if (adapter instanceof Nothing) {
    return widen(releaseLease(ai, workspaceId, attempt)).chain(() =>
      Future.reject<AiError | Error, Advanced>({ type: "route_not_ready" })
    )
  }

  return dispatchStep(ai, workspaceId, attempt, adapter.value, step, timeout)
}

/** Matches the claimed attempt's method against the step it was sent, and runs the one pairing that applies. */
function dispatchStep(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  step: Step,
  timeout: Duration
): Future<AiError | Error, Advanced> {
  switch (step.kind) {
    case "retry":
      return dispatchRetry(ai, workspaceId, attempt, adapter, timeout)
    case "poll":
      return dispatchPoll(ai, workspaceId, attempt, adapter, timeout)
    case "secret":
      return dispatchSecret(ai, workspaceId, attempt, adapter, step, timeout)
    default:
      return step satisfies never
  }
}

/** Only a `verification_failed` attempt with a kept credential can retry — anything else is a bad pairing. */
function dispatchRetry(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  timeout: Duration
): Future<AiError | Error, Advanced> {
  return attempt.state === "verification_failed" && attempt.credentialRef instanceof Just
    ? widen(verifyCredential(ai, workspaceId, attempt, adapter, attempt.credentialRef.value, timeout))
    : invalidStep(ai, workspaceId, attempt)
}

/** Only a device attempt has anything to poll. */
function dispatchPoll(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  timeout: Duration
): Future<AiError | Error, Advanced> {
  if (attempt.method === "device") return widen(pollDevice(ai, workspaceId, attempt, adapter, timeout))
  return invalidStep(ai, workspaceId, attempt)
}

function dispatchSecret(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  step: Extract<Step, { kind: "secret" }>,
  timeout: Duration
): Future<AiError | Error, Advanced> {
  if (attempt.method !== "setup_token" && attempt.method !== "api_key") return invalidStep(ai, workspaceId, attempt)
  return widen(
    releasingOnFailure(ai, workspaceId, attempt, (r) => adapter.accept(r, step.secret)).chain((credential) =>
      afterAuthorized(ai, workspaceId, attempt, adapter, credential, timeout)
    )
  )
}

function pollDevice(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  timeout: Duration
): Future<Error, Advanced> {
  if (attempt.secretRef instanceof Nothing)
    return handleAuthorization(ai, workspaceId, attempt, adapter, { kind: "expired" }, timeout)
  return ai.vault
    .get(workspaceId, attempt.secretRef.value)
    .chain((secret) =>
      secret instanceof Nothing
        ? handleAuthorization(ai, workspaceId, attempt, adapter, { kind: "expired" }, timeout)
        : releasingOnFailure(ai, workspaceId, attempt, (r) => adapter.poll(r, secret.value)).chain((auth) =>
            handleAuthorization(ai, workspaceId, attempt, adapter, auth, timeout)
          )
    )
}

function handleAuthorization(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  auth: Authorization,
  timeout: Duration
): Future<Error, Advanced> {
  switch (auth.kind) {
    case "pending":
      return releaseToPending(ai, workspaceId, attempt)
    case "denied":
      return settleTerminal(ai, workspaceId, attempt, "denied")
    case "expired":
      return settleTerminal(ai, workspaceId, attempt, "expired")
    case "authorized":
      return afterAuthorized(ai, workspaceId, attempt, adapter, auth.credential, timeout)
    default:
      return auth satisfies never
  }
}

/** A credential was just obtained (poll or accept): put it in the vault, drop the device secret, verify. */
function afterAuthorized(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  credential: Secret,
  timeout: Duration
): Future<Error, Advanced> {
  return ai.vault
    .put(workspaceId, credential)
    .chain((ref) =>
      removeDeviceSecret(ai, workspaceId, attempt).chain(() =>
        verifyCredential(ai, workspaceId, attempt, adapter, ref, timeout)
      )
    )
}

function removeDeviceSecret(ai: AiConnections, workspaceId: Id<"Workspace">, attempt: Attempt): Future<Error, void> {
  return attempt.secretRef instanceof Just
    ? ai.vault.remove(workspaceId, [attempt.secretRef.value])
    : Future.resolve(undefined)
}

/**
 * The readiness proof. A ref the vault can no longer open is treated as `revoked` without calling the adapter.
 * `ready` is reported WITHOUT settling the attempt — the command settles it, after deciding whether this credential
 * still wins (see `advanceAuthorization.ts`). A failure settles `verification_failed` here and keeps the ref, so
 * `retry` can re-verify the same credential later.
 */
function verifyCredential(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  adapter: ProviderAdapter,
  ref: Id<"AiSecret">,
  timeout: Duration
): Future<Error, Advanced> {
  return ai.vault
    .get(workspaceId, ref)
    .chain((secret) =>
      secret instanceof Nothing
        ? settleVerificationFailed(ai, workspaceId, attempt, ref, "revoked")
        : boundedVerify(adapter, route(attempt), secret.value, timeout).chain((readiness) =>
            readiness.kind === "ready"
              ? Future.resolve<Error, Advanced>({ kind: "ready", attempt, credentialRef: ref, readiness })
              : settleVerificationFailed(ai, workspaceId, attempt, ref, readiness.reason)
          )
    )
}

/**
 * `Future.race` against a timer that resolves (never rejects) `unreachable`, so a provider that never answers
 * settles instead of hanging forever. Shared with `command/testConnection.ts`, the one other caller of `verify`.
 */
function boundedVerify(
  adapter: ProviderAdapter,
  r: Route,
  secret: Secret,
  timeout: Duration
): Future<Error, Readiness> {
  const timedOut = Future.create<Error, Readiness>((_, resolve) => {
    const timer = setTimeout(() => resolve({ kind: "failed", reason: "unreachable" }), timeout.asMilliseconds())
    return () => clearTimeout(timer)
  })
  // A rejected verify (a network error in a real adapter) is the same outcome as no answer: retryable, not a 500.
  const verified = adapter.verify(r, secret).chainRej((error) => {
    logAdapterFailure("verify", r, error)
    return Future.resolve<Error, Readiness>({ kind: "failed", reason: "unreachable" })
  })
  return Future.race(verified, timedOut)
}

function settleVerificationFailed(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  ref: Id<"AiSecret">,
  reason: FailureReason
): Future<Error, Advanced> {
  return ai.attempts
    .settle(workspaceId, attempt.attemptId, {
      state: "verification_failed",
      failure: Just(reason),
      credentialRef: Just(ref),
    })
    .chain((kept) =>
      // A cancel or a newer attempt closed this one mid-verify: nothing will ever retry this credential, so drop it.
      kept ? Future.resolve<Error, void>(undefined) : ai.vault.remove(workspaceId, [ref])
    )
    .map((): Advanced => ({ kind: "failed", attempt, reason }))
}

/** `denied`/`expired` share their `AttemptState` and `FailureReason` spelling, so one helper settles either. */
function settleTerminal(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  reason: "denied" | "expired"
): Future<Error, Advanced> {
  return ai.attempts
    .settle(workspaceId, attempt.attemptId, { state: reason, failure: Just(reason), credentialRef: Nothing() })
    .chain((closed) => (closed ? removeDeviceSecret(ai, workspaceId, attempt) : Future.resolve<Error, void>(undefined)))
    .map((): Advanced => ({ kind: "failed", attempt, reason }))
}

/** Clears the lease without changing the recorded outcome, then reports `pending`. */
function releaseToPending(ai: AiConnections, workspaceId: Id<"Workspace">, attempt: Attempt): Future<Error, Advanced> {
  return ai.attempts
    .settle(workspaceId, attempt.attemptId, {
      state: "pending",
      failure: Nothing(),
      credentialRef: attempt.credentialRef,
    })
    .map((): Advanced => ({ kind: "pending", attempt }))
}

/** Clears the lease, changing nothing else. */
function releaseLease(ai: AiConnections, workspaceId: Id<"Workspace">, attempt: Attempt): Future<Error, boolean> {
  return ai.attempts.settle(workspaceId, attempt.attemptId, {
    state: attempt.state,
    failure: attempt.failure,
    credentialRef: attempt.credentialRef,
  })
}

function invalidStep(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt
): Future<AiError | Error, Advanced> {
  return widen(releaseLease(ai, workspaceId, attempt)).chain(() =>
    Future.reject<AiError | Error, Advanced>({ type: "invalid_step" })
  )
}

/**
 * Run one adapter call on a claimed attempt; if it rejects, release the lease first so the user can try again at
 * once instead of being answered `pending` for 30 s.
 */
function releasingOnFailure<T>(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  attempt: Attempt,
  call: (r: Route) => Future<Error, T>
): Future<Error, T> {
  const r = route(attempt)
  return call(r).chainRej((error) => {
    logAdapterFailure(attempt.method, r, error)
    return releaseLease(ai, workspaceId, attempt).chain(() => Future.reject<Error, T>(error))
  })
}

/** Only the error's class: an adapter message may quote a provider response, and a response may echo a secret. */
function logAdapterFailure(call: string, r: Route, error: Error): void {
  console.error(`AI adapter ${call} failed for ${r.provider}/${r.method}: ${error.name}`)
}
