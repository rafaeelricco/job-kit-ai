export {
  GOOGLE_START_PATH,
  GOOGLE_CALLBACK_PATH,
  type GoogleSignInError,
  startGoogleSignIn,
  finishGoogleSignIn,
  safeReturnTo,
  GOOGLE_COOKIE,
  clearGoogleCookie,
}

import * as s from "@lib/json/schema"

import { randomBytes } from "node:crypto"
import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { type Response } from "@be/lib/router"
import { type WithEventStore } from "@be/lib/event-sourcing/store"
import { type Session, setCookie } from "@be/app/session"
import { type GoogleOidc } from "@be/lib/google-oidc"
import { internalServerError } from "@be/app/responses"
import { parseEmail } from "@be/domain/auth/command/authErrors"
import { provisionUser } from "@be/domain/auth/provisionUser"
import { GOOGLE_START_PATH, type GoogleSignInError } from "@be/domain/auth/googleSignIn.api"

const GOOGLE_CALLBACK_PATH = "/api/v1/auth/google/callback"

/** Holds the round trip's secrets; scoped to the Google routes and dead after 10 minutes. */
const GOOGLE_COOKIE = "g_oauth"
const COOKIE_PATH = GOOGLE_START_PATH.replace(/\/start$/, "")
const clearGoogleCookie = setCookie(GOOGLE_COOKIE, "", 0, COOKIE_PATH)

const schema_pending = s.object({ state: s.string, nonce: s.string, verifier: s.string, returnTo: s.string })
type Pending = s.Infer<typeof schema_pending>

const random = (): string => randomBytes(32).toString("base64url")

/** Internal app paths only: `/x` passes, `//evil.com` and `/\evil.com` fall back to `/`. */
function safeReturnTo(path: string): string {
  return /^\/(?![/\\])/.test(path) && !path.includes("\\") ? path : "/"
}

/**
 * `path` resolved under the app, or the app root when it would leave it. Checked on the resolved URL, not the
 * string: the URL parser drops tabs and newlines, so `/\t//evil.com` passes `safeReturnTo` and resolves off-site.
 */
function appUrl(base: string, path: string): string {
  const root = new URL(base)
  const url = new URL(path.slice(1), root)
  return url.origin === root.origin && url.pathname.startsWith(root.pathname) ? url.href : root.href
}
const failedUrl = (base: string, error: GoogleSignInError): string => appUrl(base, `/sign-in?error=${error}`)

/** Where to send the browser, and the cookie that carries state, nonce and PKCE verifier to the callback. */
function startGoogleSignIn(oidc: GoogleOidc, base: string, returnTo: string): { location: string; cookies: string[] } {
  if (!oidc.configured) return { location: failedUrl(base, "unavailable"), cookies: [] }
  const pending: Pending = { state: random(), nonce: random(), verifier: random(), returnTo: safeReturnTo(returnTo) }
  const value = Buffer.from(JSON.stringify(s.encode(schema_pending, pending))).toString("base64url")
  return {
    location: oidc.authorizationUrl({
      state: pending.state,
      nonce: pending.nonce,
      verifier: pending.verifier,
    }),
    cookies: [setCookie(GOOGLE_COOKIE, value, 600, COOKIE_PATH)],
  }
}

/**
 * Finish the round trip and answer with the URL to land on: the saved return path on success, or
 * `/sign-in?error=…`. Never rejects. Google's verified email names the user, so a Google sign-in and an
 * emailed code for one address reach the same user and workspace; an unverified email is refused.
 */
function finishGoogleSignIn(args: {
  query: Record<string, unknown>
  pending: Maybe<string>
  oidc: GoogleOidc
  base: string
  session: Session
  withEventStore: WithEventStore
}): Future<never, string> {
  const { query, oidc, base, session, withEventStore } = args
  const fail = (error: GoogleSignInError) => Future.reject<GoogleSignInError, string>(error)
  const pending = args.pending.chain((raw) =>
    s.decode(s.stringified(schema_pending), Buffer.from(raw, "base64url").toString("utf8")).either<Maybe<Pending>>(
      () => Nothing(),
      (value) => Just(value)
    )
  )
  return pending
    .maybe(fail("failed"), (p) =>
      query["error"] !== undefined
        ? fail(query["error"] === "access_denied" ? "cancelled" : "failed")
        : typeof query["code"] !== "string" || query["state"] !== p.state
          ? fail("failed")
          : oidc
              .exchange(query["code"], p.verifier)
              .mapRej((): GoogleSignInError => "failed")
              .chain((claims) =>
                claims.nonce !== p.nonce || claims.email_verified !== true
                  ? fail("failed")
                  : parseEmail(claims.email ?? "").either(
                      () => fail("failed"),
                      (email) =>
                        provisionUser(withEventStore, email)
                          .chain((userId) => session.start(userId).mapRej((): Response => internalServerError))
                          .mapRej((): GoogleSignInError => "failed")
                          .map(() => appUrl(base, p.returnTo))
                    )
              )
    )
    .chainRej((error) => Future.resolve<never, string>(failedUrl(base, error)))
}
