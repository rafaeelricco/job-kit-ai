import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Just, Nothing } from "@lib/maybe"
import { Future } from "@lib/future"
import { MemoryEventDatabase, MemorySessionStore, MemoryLoginCodes } from "@tests/support/memory"
import { result } from "@tests/support/notes"
import { Session } from "@be/app/session"
import { User } from "@be/domain/user/aggregate/user"
import { type GoogleOidc, type TokenPayload } from "@be/lib/google-oidc"
import { startGoogleSignIn, finishGoogleSignIn, safeReturnTo, GOOGLE_COOKIE } from "@be/lib/google"
import { controller as requestCode } from "@be/domain/auth/command/requestCode"
import { controller as verifyCode } from "@be/domain/auth/command/verifyCode"

const EMAIL = "user@example.test"
const BASE = "http://localhost:5173/jobs/"

const anonymousAuth = { actor: { type: "Anonymous" as const }, auth: { result: "allow" as const } }

/** Claims as Google's library hands them back once it has verified the ID token. */
const claims = (overrides: Partial<TokenPayload>): TokenPayload => ({
  iss: "https://accounts.google.com",
  aud: "client-id",
  sub: "google-sub",
  iat: 0,
  exp: 0,
  email: EMAIL,
  email_verified: true,
  ...overrides,
})

/** A stub `GoogleOidc`, always "configured" unless told otherwise; `exchange` defaults to failing loudly if called unexpectedly. */
function stubOidc(
  exchange: GoogleOidc["exchange"] = () => Future.reject(new Error("exchange not stubbed for this test"))
): GoogleOidc {
  return { configured: true, authorizationUrl: () => "https://accounts.google.com/o/oauth2/v2/auth?stub", exchange }
}

/** Pulls a cookie's value out of a `Set-Cookie` header string, as the browser would before the next request. */
function cookieValue(setCookieHeader: string, name: string): string {
  const match = new RegExp(`^${name}=([^;]*)`).exec(setCookieHeader)
  assert.ok(match, `Expected a ${name} cookie in "${setCookieHeader}"`)
  return match[1] ?? ""
}

/** Decodes the `g_oauth` cookie's payload the same way `finishGoogleSignIn` does, so tests can read `state`/`nonce` back. */
function decodePending(value: string): { state: string; nonce: string; verifier: string; returnTo: string } {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
    state: string
    nonce: string
    verifier: string
    returnTo: string
  }
}

/** Runs `startGoogleSignIn` and hands back the pending cookie's raw value and decoded payload. */
function begin(returnTo = "/"): { pendingValue: string; pending: ReturnType<typeof decodePending> } {
  const { cookies } = startGoogleSignIn(stubOidc(), BASE, returnTo)
  const pendingValue = cookieValue(cookies[0] ?? "", GOOGLE_COOKIE)
  return { pendingValue, pending: decodePending(pendingValue) }
}

describe("Google sign-in", () => {
  test("success lands on APP_URL + returnTo, sets the session cookie, and provisions the user and workspace", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const { pendingValue, pending } = begin("/dossiers?x=1")
    const session = new Session(sessions, Nothing())

    const location = await finishGoogleSignIn({
      query: { code: "auth-code", state: pending.state },
      pending: Just(pendingValue),
      oidc: stubOidc(() => Future.resolve<Error, TokenPayload>(claims({ nonce: pending.nonce }))),
      base: BASE,
      session,
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))

    assert.equal(location, `${BASE}dossiers?x=1`)
    assert.match(session.headers["Set-Cookie"] ?? "", /^sid=token-1; HttpOnly/)
    assert.deepEqual(
      db.entries.map((entry) => entry.event_name),
      ["UserJoined", "WorkspaceProvisioned"]
    )
  })

  test("the same email then signing in by code reaches the same user id", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const { pendingValue, pending } = begin()
    const googleSession = new Session(sessions, Nothing())
    await finishGoogleSignIn({
      query: { code: "auth-code", state: pending.state },
      pending: Just(pendingValue),
      oidc: stubOidc(() => Future.resolve<Error, TokenPayload>(claims({ nonce: pending.nonce }))),
      base: BASE,
      session: googleSession,
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))

    const loginCodes = new MemoryLoginCodes()
    await result(
      requestCode.handler({
        payload: { email: EMAIL },
        ...anonymousAuth,
        session: new Session(sessions, Nothing()),
        loginCodes,
        withEventStore: db.withEventStore,
      })
    )
    const code = loginCodes.live.get(EMAIL)
    assert.ok(code)
    const byCode = await result(
      verifyCode.handler({
        payload: { email: EMAIL, code },
        ...anonymousAuth,
        session: new Session(sessions, Nothing()),
        loginCodes,
        withEventStore: db.withEventStore,
      })
    )
    assert.equal(byCode.userId.value, User.idForEmail(EMAIL).value)
    assert.equal(db.entries.length, 2, "No new events for the second, already-provisioned sign-in")
  })

  test("error=access_denied gives cancelled, a state mismatch gives failed, and a missing cookie gives failed", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const { pendingValue, pending } = begin()

    const missingCookie = await finishGoogleSignIn({
      query: { code: "c", state: pending.state },
      pending: Nothing(),
      oidc: stubOidc(),
      base: BASE,
      session: new Session(sessions, Nothing()),
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))
    assert.equal(missingCookie, `${BASE}sign-in?error=failed`)

    const stateMismatch = await finishGoogleSignIn({
      query: { code: "c", state: "not-the-real-state" },
      pending: Just(pendingValue),
      oidc: stubOidc(),
      base: BASE,
      session: new Session(sessions, Nothing()),
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))
    assert.equal(stateMismatch, `${BASE}sign-in?error=failed`)

    const cancelled = await finishGoogleSignIn({
      query: { error: "access_denied" },
      pending: Just(pendingValue),
      oidc: stubOidc(),
      base: BASE,
      session: new Session(sessions, Nothing()),
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))
    assert.equal(cancelled, `${BASE}sign-in?error=cancelled`)

    assert.equal(db.entries.length, 0)
  })

  test("a nonce mismatch gives failed; an unverified email gives failed and emits nothing", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()

    const nonceCase = begin()
    const nonceMismatch = await finishGoogleSignIn({
      query: { code: "c", state: nonceCase.pending.state },
      pending: Just(nonceCase.pendingValue),
      oidc: stubOidc(() => Future.resolve<Error, TokenPayload>(claims({ nonce: "wrong-nonce" }))),
      base: BASE,
      session: new Session(sessions, Nothing()),
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))
    assert.equal(nonceMismatch, `${BASE}sign-in?error=failed`)

    const unverifiedCase = begin()
    const unverified = await finishGoogleSignIn({
      query: { code: "c", state: unverifiedCase.pending.state },
      pending: Just(unverifiedCase.pendingValue),
      oidc: stubOidc(() =>
        Future.resolve<Error, TokenPayload>(claims({ email_verified: false, nonce: unverifiedCase.pending.nonce }))
      ),
      base: BASE,
      session: new Session(sessions, Nothing()),
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))
    assert.equal(unverified, `${BASE}sign-in?error=failed`)

    assert.equal(db.entries.length, 0)
  })

  test("an unconfigured client gives unavailable at start", () => {
    const unconfigured: GoogleOidc = {
      configured: false,
      authorizationUrl: () => "",
      exchange: () => Future.reject(new Error("must not be called when unconfigured")),
    }
    const { location, cookies } = startGoogleSignIn(unconfigured, BASE, "/")
    assert.equal(location, `${BASE}sign-in?error=unavailable`)
    assert.deepEqual(cookies, [])
  })

  test("safeReturnTo keeps internal paths and rejects protocol-relative or backslash escapes", () => {
    assert.equal(safeReturnTo("//evil.com"), "/")
    assert.equal(safeReturnTo("/\\evil.com"), "/")
    assert.equal(safeReturnTo("/dossiers?x=1"), "/dossiers?x=1")
  })

  // The URL parser drops tabs and newlines, so `/\t//evil.com` passes a string check and resolves off-site.
  test.each([
    ["a tab-smuggled returnTo from start", "/\t//evil.com", false],
    ["a newline-smuggled returnTo from start", "/\n//evil.com", false],
    ["a forged cookie with an absolute URL", "xhttps://evil.com", true],
  ])("never redirects off-site: %s", async (_, returnTo, forged) => {
    const db = new MemoryEventDatabase()
    const started = begin(returnTo)
    const pending = forged ? { ...started.pending, returnTo } : started.pending
    const pendingValue = Buffer.from(JSON.stringify(pending)).toString("base64url")

    const location = await finishGoogleSignIn({
      query: { code: "auth-code", state: pending.state },
      pending: Just(pendingValue),
      oidc: stubOidc(() => Future.resolve<Error, TokenPayload>(claims({ nonce: pending.nonce }))),
      base: BASE,
      session: new Session(new MemorySessionStore(), Nothing()),
      withEventStore: db.withEventStore,
    }).promise((error) => new Error(String(error)))

    assert.equal(new URL(location).origin, new URL(BASE).origin)
    assert.ok(new URL(location).pathname.startsWith("/jobs/"), location)
  })
})
