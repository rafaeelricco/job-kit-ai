/**
 * @file `Auth` — capability-based guard builders for endpoints (see ./README.md).
 * Each builder returns an {@link AuthGuard} for a controller's `authGuard` field;
 * on allow it mints an {@link Authorized} proof (see ./grants.ts) for the handler.
 */

export { Auth, type AuthGuard, type AuthGuardResult, type GuardResult }

import { type AuthContext } from "@be/app/resolveAuth"
import {
  type SystemCapabilities,
  type SessionCapabilities,
  type Public,
  type Authenticated,
  type Authorized,
  grant,
} from "@be/app/auth/grants"

type Deny = { result: "deny"; status: 401 | 403; message: string }

/**
 * - "allow": the request is authorized; the variant may carry a proof for the handler.
 * - "deny": `status` is the HTTP reply — 401 unauthenticated, 403 authenticated but unprivileged.
 */
type AuthGuardResult = { result: "allow" } | Deny

/**
 * A pure check over the request's resolved {@link AuthContext}. Guards see
 * privileges, never roles. (The reference application's async `resolve` stage returns with the
 * first guard that must load domain data before deciding.)
 */
type AuthGuard<Result extends AuthGuardResult = AuthGuardResult> = (auth: AuthContext) => Result

/** A guard's full result type (allow ∪ deny) — a controller's `Result`: `GuardResult<typeof authGuard>`. */
type GuardResult<G> = G extends AuthGuard<infer R> ? R : never

/** The capability names each catalog declares — `never` while a catalog is empty. */
type SystemCapability = keyof SystemCapabilities & string
type SessionCapability = keyof SessionCapabilities & string

// Each builder's allow branch: the exact proof its guard hands the handler.
type AllowPublic = { result: "allow" } & Public
type AllowAuthenticated = { result: "allow" } & Authenticated
type AllowSystem<P extends SystemCapability> = { result: "allow" } & Authorized<`system:${P}`>
type AllowSession<P extends SessionCapability> = { result: "allow" } & Authorized<`session:${P}`>
type AllowOf<Gs extends AuthGuard[]> = Extract<GuardResult<Gs[number]>, { result: "allow" }>

/** Build a denial. 401 = unauthenticated, 403 = authenticated but unprivileged. */
const deny = (status: 401 | 403, message: string): Deny => ({ result: "deny", status, message })
const unauthenticated = (): Deny => deny(401, "Authentication required")

/** Allow anyone, even anonymous — the handler inspects `actor` itself (e.g. whoAmI). */
function publicAccess(): AuthGuard<AllowPublic> {
  return () => ({ result: "allow" })
}

/** Require a signed-in user but no privilege (e.g. signOut); 401 if anonymous. */
function authenticated(): AuthGuard<AllowAuthenticated | Deny> {
  return (auth) => (auth.actor.type === "User" ? { result: "allow", actor: auth.actor } : unauthenticated())
}

/** Require a system-wide privilege; on allow, mints a `system:P` proof. */
function system<P extends SystemCapability>(capability: P): AuthGuard<AllowSystem<P> | Deny> {
  return (auth) => {
    if (auth.actor.type !== "User") return unauthenticated()
    const key = `system:${capability}` as const
    if (auth.privileges.includes(key)) return { result: "allow", ...grant(auth.actor, key) }
    return deny(403, `Requires ${capability} privilege`)
  }
}

/** Require a session-derived capability; `message` overrides the 403 text. */
function session<P extends SessionCapability>(capability: P, message?: string): AuthGuard<AllowSession<P> | Deny> {
  return (auth) => {
    if (auth.actor.type !== "User") return unauthenticated()
    const key = `session:${capability}` as const
    if (auth.privileges.includes(key)) return { result: "allow", ...grant(auth.actor, key) }
    return deny(403, message ?? `Requires ${capability}`)
  }
}

/**
 * "A or B": try each guard in order; the first allow wins, else the last denial.
 * "A and B" has no builder yet: a proof carries one grant, so `Authorized<A | B>`
 * means "A or B", not both.
 */
function anyOf<Gs extends AuthGuard[]>(...guards: Gs): AuthGuard<AllowOf<Gs> | Deny> {
  return (auth) => {
    let last: Deny = deny(403, "Forbidden")
    for (const guard of guards) {
      const r = guard(auth)
      if (r.result === "allow") return r as AllowOf<Gs>
      last = r
    }
    return last
  }
}

/** The public auth API (see ./README.md). */
const Auth = { public: publicAccess, authenticated, system, session, anyOf }
