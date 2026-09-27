import assert from "node:assert/strict"
import { createSign, generateKeyPairSync } from "node:crypto"
import { afterEach, beforeEach, describe, onTestFinished, test, vi } from "vitest"
import { googleOidc } from "@be/lib/google-oidc"

const CLIENT_ID = "client-id.apps.googleusercontent.com"
const CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs"
const google = generateKeyPairSync("rsa", { modulusLength: 2048 })
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 })

/** An RS256 ID token signed with `key`, carrying Google's certificate id. */
function idToken(claims: Record<string, unknown>, key = google.privateKey): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const signed = `${part({ alg: "RS256", kid: "test-key" })}.${part(claims)}`
  return `${signed}.${createSign("RSA-SHA256").update(signed).sign(key, "base64url")}`
}

const now = Math.floor(Date.now() / 1000)
const valid = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "google-sub",
  iat: now,
  exp: now + 300,
  email: "pilot@example.test",
  email_verified: true,
  nonce: "n-1",
}

/** Google's token endpoint answers `body` with `status`; its certs endpoint serves the test key. */
function fakeGoogle(body: unknown, status = 200) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
    String(url) === CERTS_URL
      ? Response.json({ "test-key": google.publicKey.export({ type: "spki", format: "pem" }) })
      : Response.json(body, { status })
  )
}
const oidcWith = (fetch: typeof globalThis.fetch) =>
  googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: "http://localhost/callback", fetch })

/** Everything the wrapper wrote to the error log, as one string to search. */
const logged = () => JSON.stringify(vi.mocked(console.error).mock.calls)

beforeEach(() => void vi.spyOn(console, "error").mockImplementation(() => {}))
afterEach(() => void vi.restoreAllMocks())

describe("googleOidc.configured", () => {
  test.each([
    ["an id and a secret", true, CLIENT_ID, "secret"],
    ["an id without a secret", false, CLIENT_ID, ""],
    ["a secret without an id", false, "", "secret"],
    ["neither", false, "", ""],
  ])("with %s is %s", (_, configured, clientId, clientSecret) => {
    assert.equal(
      googleOidc({ clientId, clientSecret, redirectUri: "http://localhost/callback" }).configured,
      configured
    )
  })
})

describe("googleOidc.exchange", () => {
  test("returns the verified claims, sending the PKCE verifier", async () => {
    const fetch = fakeGoogle({ id_token: idToken(valid) })
    const claims = await oidcWith(fetch)
      .exchange("auth-code", "verifier-1")
      .promise((e) => e)
    assert.equal(claims.email, "pilot@example.test")
    assert.equal(claims.email_verified, true)
    assert.equal(claims.nonce, "n-1")
    const tokenCall = fetch.mock.calls.find(([url]) => String(url) !== CERTS_URL)
    const sent = new URLSearchParams(String(tokenCall?.[1]?.body))
    assert.equal(sent.get("code_verifier"), "verifier-1")
    assert.equal(sent.get("grant_type"), "authorization_code")
  })

  test("uses the global fetch when none is given", async () => {
    vi.stubGlobal("fetch", fakeGoogle({ id_token: idToken(valid) }))
    onTestFinished(() => void vi.unstubAllGlobals())
    const oidc = googleOidc({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: "http://localhost/callback" })
    const claims = await oidc.exchange("auth-code", "verifier-1").promise((e) => e)
    assert.equal(claims.email, "pilot@example.test")
  })

  test.each([
    ["another issuer", idToken({ ...valid, iss: "https://evil.example" }), /Invalid issuer/],
    ["another client's audience", idToken({ ...valid, aud: "someone-else" }), /Wrong recipient/],
    ["an expired token", idToken({ ...valid, iat: now - 900, exp: now - 600 }), /Token used too late/], // past the 300 s skew
    ["a token signed by another key", idToken(valid, stranger.privateKey), /Invalid token signature/],
    ["a token without an issue time", idToken({ ...valid, iat: undefined }), /No issue time/],
  ])("rejects %s", async (_, token, reason) => {
    await assert.rejects(
      oidcWith(fakeGoogle({ id_token: token }))
        .exchange("auth-code", "verifier-1")
        .promise((e) => e),
      reason
    )
  })

  test("rejects with Google's error code when the token endpoint refuses, logging no code or verifier", async () => {
    await assert.rejects(
      oidcWith(fakeGoogle({ error: "invalid_grant" }, 400))
        .exchange("auth-code", "verifier-1")
        .promise((e) => e),
      /^Error: invalid_grant$/
    )
    assert.match(logged(), /invalid_grant/)
    assert.doesNotMatch(logged(), /auth-code|verifier-1|secret/)
  })

  test("logs and rejects with the library's reason, never the token or its claims", async () => {
    const token = idToken(valid, stranger.privateKey)
    await assert.rejects(
      oidcWith(fakeGoogle({ id_token: token }))
        .exchange("auth-code", "verifier-1")
        .promise((e) => e),
      (error: Error) => error.message === "Invalid token signature"
    )
    assert.deepEqual(vi.mocked(console.error).mock.calls, [["Google sign-in failed", "Invalid token signature"]])
  })

  test("rejects a token response without an id_token", async () => {
    await assert.rejects(
      oidcWith(fakeGoogle({ access_token: "a" }))
        .exchange("auth-code", "verifier-1")
        .promise((e) => e)
    )
  })

  test("builds an S256 authorization URL carrying state, nonce and the verifier's challenge", () => {
    // RFC 7636 Appendix B: this verifier's S256 challenge.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    const url = new URL(oidcWith(fakeGoogle({})).authorizationUrl({ state: "s", nonce: "n", verifier }))
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth")
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID)
    assert.equal(url.searchParams.get("code_challenge_method"), "S256")
    assert.equal(url.searchParams.get("code_challenge"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    assert.equal(url.searchParams.get("scope"), "openid email")
    assert.equal(url.searchParams.get("state"), "s")
    assert.equal(url.searchParams.get("nonce"), "n")
    assert.equal(url.searchParams.get("prompt"), "select_account")
  })
})
