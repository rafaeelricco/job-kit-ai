import assert from "node:assert/strict"
import { type Mock, describe, test, vi } from "vitest"

import { type ClientOptions } from "openai"

import { Future } from "@lib/future"
import { isRecord } from "@lib/helpers/object"
import { Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { rejection } from "@tests/support/future"

import { CredentialRevoked } from "@be/domain/ai/adapter"
import { requestXaiDeviceCode, pollXaiDeviceToken, ensureFreshXaiTokens, fetchXaiUser } from "@be/app/ai/auth/xai"
import { xaiClientOptions } from "@be/app/ai/llm/xai"

const run = <T>(f: Future<Error, T>): Promise<T> => f.promise((e) => e)

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<Response>>

/** Stubs `fetch` with one canned response per call, and hands back the calls for inspection. */
function stubFetch(respond: (url: string) => Response): FetchMock {
  const fetchMock: FetchMock = vi.fn(async (url: string, _init?: RequestInit) => respond(url))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const formOf = (init: RequestInit | undefined): URLSearchParams => new URLSearchParams(String(init?.body))

/** Asserts the call was a form POST that `AbortSignal.timeout` still bounds. */
function assertBoundedForm(init: RequestInit | undefined): void {
  assert.equal(init?.method, "POST")
  assert.equal(new Headers(init?.headers).get("content-type"), "application/x-www-form-urlencoded")
  assert.ok(init?.signal instanceof AbortSignal)
  assert.equal(init.signal.aborted, false)
}

describe("xaiClientOptions", () => {
  const headersOf = (options: ClientOptions): Record<string, unknown> => {
    assert.ok(isRecord(options.defaultHeaders))
    return options.defaultHeaders
  }

  test("an API key goes straight to api.x.ai with SDK retries off", () => {
    const options = xaiClientOptions({ kind: "api_key", key: "xai-test" })

    assert.equal(options.baseURL, "https://api.x.ai/v1")
    assert.equal(options.apiKey, "xai-test")
    assert.equal(options.maxRetries, 0)
    assert.equal(options.defaultHeaders, undefined)
  })

  test("a sign-in goes through the CLI proxy and flags the bearer as a user token", () => {
    const options = xaiClientOptions({ kind: "xai_oauth", accessToken: "grok-access" })

    assert.equal(options.baseURL, "https://cli-chat-proxy.grok.com/v1")
    assert.equal(options.apiKey, "grok-access")
    assert.equal(headersOf(options)["X-XAI-Token-Auth"], "xai-grok-cli")
  })

  test("a sign-in disables SDK retries so a metered subscription is not burned three times over", () => {
    assert.equal(xaiClientOptions({ kind: "xai_oauth", accessToken: "grok-access" }).maxRetries, 0)
  })

  test("a sign-in sends a semver client version", () => {
    const version = headersOf(xaiClientOptions({ kind: "xai_oauth", accessToken: "grok-access" }))[
      "x-grok-client-version"
    ]

    assert.match(String(version), /^\d+\.\d+\.\d+$/)
  })
})

describe("requestXaiDeviceCode", () => {
  const deviceBody = {
    device_code: "dev-1",
    user_code: "BB88-BABF",
    verification_uri: "https://auth.x.ai/oauth2/device",
    interval: 7,
    expires_in: 1800,
  }

  test("posts a form-encoded request with the client id, scope and the grok-build referrer", async () => {
    const fetchMock = stubFetch(() => json(deviceBody))

    await run(requestXaiDeviceCode())

    const [url, init] = fetchMock.mock.calls[0] ?? []
    assert.equal(url, "https://auth.x.ai/oauth2/device/code")
    assertBoundedForm(init)
    const form = formOf(init)
    assert.equal(form.get("client_id"), CLIENT_ID)
    assert.match(form.get("scope") ?? "", /offline_access/)
    assert.equal(form.get("referrer"), "grok-build")
  })

  test("maps the code, the interval and the expiry", async () => {
    stubFetch(() => json(deviceBody))

    const before = POSIX.now()
    const device = await run(requestXaiDeviceCode())
    const after = POSIX.now()

    assert.equal(device.deviceCode, "dev-1")
    assert.equal(device.userCode, "BB88-BABF")
    assert.equal(device.verificationUri, "https://auth.x.ai/oauth2/device")
    assert.deepEqual(device.interval, Duration.seconds(7))
    assert.ok(device.expiresAt.value >= before.addDuration(Duration.seconds(1800)).value)
    assert.ok(device.expiresAt.value <= after.addDuration(Duration.seconds(1800)).value)
  })

  test("polls every 5 seconds when xAI names no interval", async () => {
    stubFetch(() => json({ ...deviceBody, interval: undefined }))

    const device = await run(requestXaiDeviceCode())

    assert.deepEqual(device.interval, Duration.seconds(5))
  })

  test("rejects a verification URI that is not https", async () => {
    stubFetch(() => json({ ...deviceBody, verification_uri: "http://auth.x.ai/oauth2/device" }))

    const error = await rejection(requestXaiDeviceCode())

    assert.equal(error.message, "xAI device authorization response was invalid")
  })

  test("rejects a verification URI that is not a URL", async () => {
    stubFetch(() => json({ ...deviceBody, verification_uri: "auth.x.ai/oauth2/device" }))

    const error = await rejection(requestXaiDeviceCode())

    assert.equal(error.message, "xAI device authorization response was invalid")
  })

  test("rejects a response missing a field", async () => {
    stubFetch(() => json({ ...deviceBody, user_code: undefined }))

    const error = await rejection(requestXaiDeviceCode())

    assert.equal(error.message, "xAI device authorization response was invalid")
  })

  test("a refusal reports the status and never the body", async () => {
    stubFetch(() => json({ error: "invalid_client", error_description: "client secret leaked here" }, 400))

    const error = await rejection(requestXaiDeviceCode())

    assert.equal(error.message, "xAI device authorization failed (400)")
  })
})

describe("pollXaiDeviceToken", () => {
  const grant = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }

  test("posts the device_code grant with the client id", async () => {
    const fetchMock = stubFetch(() => json(grant))

    await run(pollXaiDeviceToken("dev-1"))

    const [url, init] = fetchMock.mock.calls[0] ?? []
    assert.equal(url, "https://auth.x.ai/oauth2/token")
    assertBoundedForm(init)
    const form = formOf(init)
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code")
    assert.equal(form.get("device_code"), "dev-1")
    assert.equal(form.get("client_id"), CLIENT_ID)
  })

  test("authorization_pending is pending", async () => {
    stubFetch(() => json({ error: "authorization_pending" }, 400))

    assert.deepEqual(await run(pollXaiDeviceToken("dev-1")), { status: "pending" })
  })

  test("slow_down carries the interval xAI names", async () => {
    stubFetch(() => json({ error: "slow_down", interval: 12 }, 400))

    assert.deepEqual(await run(pollXaiDeviceToken("dev-1")), {
      status: "slow_down",
      interval: Just(Duration.seconds(12)),
    })
  })

  test("slow_down with no interval leaves the step to the caller", async () => {
    stubFetch(() => json({ error: "slow_down" }, 400))

    assert.deepEqual(await run(pollXaiDeviceToken("dev-1")), { status: "slow_down", interval: Nothing() })
  })

  test("access_denied and authorization_denied are denied", async () => {
    for (const error of ["access_denied", "authorization_denied"]) {
      stubFetch(() => json({ error }, 400))
      assert.deepEqual(await run(pollXaiDeviceToken("dev-1")), { status: "denied" })
    }
  })

  test("expired_token is expired", async () => {
    stubFetch(() => json({ error: "expired_token" }, 400))

    assert.deepEqual(await run(pollXaiDeviceToken("dev-1")), { status: "expired" })
  })

  test("a granted code is complete, with an expiry from expires_in", async () => {
    stubFetch(() => json(grant))

    const before = POSIX.now()
    const poll = await run(pollXaiDeviceToken("dev-1"))
    const after = POSIX.now()

    assert.ok(poll.status === "complete")
    assert.equal(poll.tokens.kind, "oauth")
    assert.equal(poll.tokens.accessToken, "new-access")
    assert.equal(poll.tokens.refreshToken, "new-refresh")
    assert.ok(poll.tokens.expiresAt.value >= before.addDuration(Duration.seconds(3600)).value)
    assert.ok(poll.tokens.expiresAt.value <= after.addDuration(Duration.seconds(3600)).value)
  })

  test("a grant without a refresh token rejects: the sign-in could never be renewed", async () => {
    stubFetch(() => json({ access_token: "new-access", expires_in: 3600 }))

    const error = await rejection(pollXaiDeviceToken("dev-1"))

    assert.equal(error.message, "xAI device token response was invalid")
  })

  test("an unknown error rejects with the status and none of the body", async () => {
    stubFetch(() => json({ error: "server_error", error_description: "internal detail with a token abc123" }, 500))

    const error = await rejection(pollXaiDeviceToken("dev-1"))

    assert.equal(error.message, "xAI device token polling failed (500)")
  })

  test("a body that is not JSON rejects with the status alone", async () => {
    stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }))

    const error = await rejection(pollXaiDeviceToken("dev-1"))

    assert.equal(error.message, "xAI device token polling failed (502)")
  })
})

describe("ensureFreshXaiTokens", () => {
  const stored = (expiresAt: POSIX) => ({
    kind: "oauth" as const,
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt,
  })
  const inMinutes = (minutes: number): POSIX => POSIX.now().addDuration(Duration.minutes(minutes))

  test("makes no request while the access token has more than 5 minutes left", async () => {
    const fetchMock = stubFetch(() => json({}))
    const current = stored(inMinutes(60))

    const result = await run(ensureFreshXaiTokens(current))

    assert.equal(result, current)
    assert.equal(fetchMock.mock.calls.length, 0)
  })

  test("refreshes within 5 minutes of expiry and keeps the old refresh token when none comes back", async () => {
    const fetchMock = stubFetch(() => json({ access_token: "new-access", expires_in: 3600 }))

    const before = POSIX.now()
    const result = await run(ensureFreshXaiTokens(stored(inMinutes(1))))

    assert.equal(result.accessToken, "new-access")
    assert.equal(result.refreshToken, "old-refresh")
    assert.ok(result.expiresAt.value >= before.addDuration(Duration.seconds(3600)).value)
    const [url, init] = fetchMock.mock.calls[0] ?? []
    assert.equal(url, "https://auth.x.ai/oauth2/token")
    assertBoundedForm(init)
    const form = formOf(init)
    assert.equal(form.get("grant_type"), "refresh_token")
    assert.equal(form.get("refresh_token"), "old-refresh")
    assert.equal(form.get("client_id"), CLIENT_ID)
  })

  test("stores a rotated refresh token", async () => {
    stubFetch(() => json({ access_token: "new-access", refresh_token: "rotated", expires_in: 3600 }))

    const result = await run(ensureFreshXaiTokens(stored(new POSIX(0))))

    assert.equal(result.refreshToken, "rotated")
  })

  test("a revoked refresh token gives the revoked message", async () => {
    stubFetch(() => json({ error: "invalid_grant" }, 400))

    const error = await rejection(ensureFreshXaiTokens(stored(new POSIX(0))))

    assert.ok(error instanceof CredentialRevoked)
    assert.equal(error.message, "xAI tokens have been revoked")
  })

  test("any other refusal reports the status and none of the body", async () => {
    stubFetch(() => json({ error: "server_error", error_description: "upstream exploded near abc123" }, 500))

    const error = await rejection(ensureFreshXaiTokens(stored(new POSIX(0))))

    assert.equal(error.message, "xAI token refresh failed (500)")
  })

  test("a refresh answer with no access token rejects", async () => {
    stubFetch(() => json({ expires_in: 3600 }))

    const error = await rejection(ensureFreshXaiTokens(stored(new POSIX(0))))

    assert.equal(error.message, "xAI token refresh response was invalid")
  })
})

describe("fetchXaiUser", () => {
  test("decodes sub and email, sending the access token as a bearer", async () => {
    const fetchMock = stubFetch(() => json({ sub: "user-1", email: "me@example.com" }))

    const user = await run(fetchXaiUser("grok-access"))

    assert.deepEqual(user, { sub: "user-1", email: Just("me@example.com") })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    assert.equal(url, "https://auth.x.ai/oauth2/userinfo")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer grok-access")
    assert.ok(init?.signal instanceof AbortSignal)
  })

  test("email is Nothing when the account shares none", async () => {
    stubFetch(() => json({ sub: "user-1" }))

    assert.deepEqual(await run(fetchXaiUser("grok-access")), { sub: "user-1", email: Nothing() })
  })

  test("a refusal reports the status alone", async () => {
    stubFetch(() => json({ error: "invalid_token", error_description: "token abc123 expired" }, 401))

    const error = await rejection(fetchXaiUser("grok-access"))

    assert.equal(error.message, "xAI userinfo failed (401)")
  })

  test("a claim set without sub rejects", async () => {
    stubFetch(() => json({ email: "me@example.com" }))

    const error = await rejection(fetchXaiUser("grok-access"))

    assert.equal(error.message, "xAI userinfo response was invalid")
  })
})
