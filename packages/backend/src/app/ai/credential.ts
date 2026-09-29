export { boundedVerify, resolveCredential, toResolved, logAdapterFailure, VERIFY_TIMEOUT }

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { type Id } from "@be/lib/event-sourcing/event"
import { type Route } from "@be/domain/ai/routes"
import {
  type Secret,
  type Readiness,
  type ReadinessFailure,
  type ProviderAdapter,
  CredentialRevoked,
} from "@be/domain/ai/adapter"
import { type AiConnections } from "@be/app/ai/connections"

const VERIFY_TIMEOUT = Duration.seconds(20)

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
  const verified = adapter.verify(r, secret).chainRej((error) => {
    logAdapterFailure("verify", r, error)
    return Future.resolve<Error, Readiness>({ kind: "failed", reason: "unreachable" })
  })
  return Future.race(verified, timedOut)
}

const tokensChanged = (original: Secret, fresh: Secret): Maybe<Secret> =>
  original.kind === "oauth" &&
  fresh.kind === "oauth" &&
  (fresh.accessToken !== original.accessToken || fresh.expiresAt.value !== original.expiresAt.value)
    ? Just(fresh)
    : Nothing()

type Resolved = { kind: "missing" } | { kind: "stored"; secret: Secret } | { kind: "settled"; reason: ReadinessFailure }

const toResolved = (stored: Maybe<Secret>): Resolved =>
  stored.unwrap<Resolved>(
    () => ({ kind: "missing" }),
    (secret) => ({ kind: "stored", secret })
  )

const LAPSE_MARGIN = Duration.seconds(30)

const hasLapsed = (secret: Secret): boolean =>
  secret.kind === "oauth" && !secret.expiresAt.isAfter(POSIX.now().addDuration(LAPSE_MARGIN))

class RefreshFailed extends Error {
  override readonly name = "RefreshFailed"
  readonly reason: Error

  constructor(reason: Error) {
    super("refresh failed")
    this.reason = reason
    Object.setPrototypeOf(this, RefreshFailed.prototype)
  }
}

function resolveCredential(
  ai: AiConnections,
  workspaceId: Id<"Workspace">,
  adapter: ProviderAdapter,
  r: Route,
  ref: Id<"AiSecret">
): Future<Error, Resolved> {
  return ai.vault
    .update(workspaceId, ref, (secret) =>
      adapter
        .refresh(r, secret)
        .mapRej((error) => new RefreshFailed(error))
        .map((fresh) => tokensChanged(secret, fresh))
    )
    .map(toResolved)
    .chainRej((error) => {
      if (!(error instanceof RefreshFailed)) return Future.reject<Error, Resolved>(error)
      logAdapterFailure("refresh", r, error.reason)
      if (error.reason instanceof CredentialRevoked) {
        return Future.resolve<Error, Resolved>({ kind: "settled", reason: "revoked" })
      }
      return ai.vault.get(workspaceId, ref).map((stored): Resolved => {
        const resolved = toResolved(stored)
        return resolved.kind === "stored" && hasLapsed(resolved.secret)
          ? { kind: "settled", reason: "unreachable" }
          : resolved
      })
    })
}

function logAdapterFailure(call: string, r: Route, error: Error): void {
  console.error(`AI adapter ${call} failed for ${r.provider}/${r.method}: ${error.name}`)
}
