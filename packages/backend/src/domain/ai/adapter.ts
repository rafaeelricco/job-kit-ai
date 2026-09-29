export {
  type Secret,
  type Authorization,
  type ReadinessFailure,
  type Readiness,
  type ProviderAdapter,
  CredentialRevoked,
}

import { type Future } from "@lib/future"
import { type Maybe } from "@lib/maybe"
import { POSIX } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"

import { type Route } from "@be/domain/ai/routes"
import { type Capabilities } from "@be/domain/ai/capabilities"
import { type Challenge } from "@be/domain/ai/views"

/** Never logged, never in an event, a projection, a queue payload or a response. Lives only in the vault and adapter memory. */
type Secret =
  | { kind: "token"; token: string }
  | { kind: "key"; key: string }
  | { kind: "device"; deviceCode: string }
  /** A device sign-in's tokens (commit-tools `BearerTokens`); `refresh` renews them before they lapse. */
  | { kind: "oauth"; accessToken: string; refreshToken: string; expiresAt: POSIX }

type Authorization =
  { kind: "pending" } | { kind: "denied" } | { kind: "expired" } | { kind: "authorized"; credential: Secret }

type ReadinessFailure = "invalid" | "revoked" | "expired" | "quota_exhausted" | "unreachable"
/** `accountId` lands in permanent events: make it an opaque keyed digest (an HMAC with a server key), never an email or its plain hash. */
type Readiness =
  { kind: "ready"; accountId: string; capabilities: Capabilities } | { kind: "failed"; reason: ReadinessFailure }

/**
 * The provider-adapter contract. An attempt's lease lasts 30 s and `verify` is cut off at 20 s, so `poll` and
 * `accept` must answer (or fail) within about 5 s: a slower exchange lets a duplicate request claim the attempt
 * and spend a single-use code twice.
 */
type ProviderAdapter = {
  readonly begin: (
    route: Route,
    attemptId: Id<"AiAttempt">
  ) => Future<Error, { challenge: Challenge; expiresAt: POSIX; secret: Maybe<Secret> }>
  readonly poll: (route: Route, secret: Secret) => Future<Error, Authorization> // device
  readonly accept: (route: Route, entered: string) => Future<Error, Secret> // setup_token, api_key
  /** The readiness proof: one bounded real request through the provider. The only producer of `Capabilities`. */
  readonly verify: (route: Route, credential: Secret) => Future<Error, Readiness>
  /**
   * Renews a credential close to expiry (commit-tools `ensureFresh*Tokens`); any other credential comes back as is.
   * Answers within ~5 s. Rejects with `CredentialRevoked` when the provider has withdrawn the sign-in; any other
   * rejection counts as passing.
   */
  readonly refresh: (route: Route, credential: Secret) => Future<Error, Secret>
}
/** Error messages from adapters must never quote a secret or provider response body; commands map them to a generic 500. */

/** A `refresh` rejection that means the provider withdrew the sign-in (OAuth `invalid_grant`), not a passing failure. */
class CredentialRevoked extends Error {
  override readonly name = "CredentialRevoked"

  constructor(message = "The provider revoked this sign-in") {
    super(message)
    Object.setPrototypeOf(this, CredentialRevoked.prototype)
  }
}
