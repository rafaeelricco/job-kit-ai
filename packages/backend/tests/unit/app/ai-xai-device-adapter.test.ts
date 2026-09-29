import assert from "node:assert/strict"
import { type Mock, afterEach, describe, test, vi } from "vitest"

import OpenAI from "openai"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { Id } from "@be/lib/event-sourcing/event"
import { rejection } from "@tests/support/future"

import { type Provider, type Route } from "@be/domain/ai/routes"
import { type Secret } from "@be/domain/ai/adapter"
import { maskAccount } from "@be/domain/ai/capabilities"
import { xaiDeviceAdapter } from "@be/app/ai/adapters/xai-device"
import { type Llm, type LlmCredential, type ModelListing, type Generated } from "@be/app/ai/llm/types"

const run = <T>(f: Future<Error, T>): Promise<T> => f.promise((e) => e)

const route: Route = { provider: "xai", method: "device" }
const DEVICE_URL = "https://auth.x.ai/oauth2/device/code"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const USERINFO_URL = "https://auth.x.ai/oauth2/userinfo"
const T0 = 1_700_000_000_000

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const pendingAnswer = (): Response => json({ error: "authorization_pending" }, 400)

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<Response>>
type Answers = Record<string, () => Response>

/** Stubs `fetch` with one answer per URL; a test swaps an answer by assigning to the returned record. */
function stubFetch(): { fetchMock: FetchMock; answers: Answers; calls: (url: string) => number } {
  let issued = 0
  const answers: Answers = {
    [DEVICE_URL]: () =>
      json({
        device_code: `dev-${++issued}`,
        user_code: "BB88-BABF",
        verification_uri: "https://auth.x.ai/oauth2/device",
        interval: 5,
        expires_in: 1800,
      }),
    [TOKEN_URL]: pendingAnswer,
    [USERINFO_URL]: () => json({ sub: "user-1", email: "me@example.com" }),
  }
  const fetchMock: FetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const answer = answers[url]
    if (answer === undefined) throw new Error(`unexpected fetch to ${url}`)
    return answer()
  })
  vi.stubGlobal("fetch", fetchMock)
  return { fetchMock, answers, calls: (url) => fetchMock.mock.calls.filter(([called]) => called === url).length }
}

/** Freezes `Date` (only it: `Future` and the SDK keep their real timers) and returns a way to move it. */
function clock(): (afterMs: number) => void {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(T0)
  return (afterMs) => vi.setSystemTime(T0 + afterMs)
}

afterEach(() => {
  vi.useRealTimers()
})

const listing = (overrides: Partial<ModelListing> = {}): ModelListing => ({
  id: "grok-a",
  name: "Grok A",
  createdAt: POSIX.now(),
  structuredOutput: Nothing(),
  efforts: Nothing(),
  ...overrides,
})

const okGeneration: Generated = {
  text: "OK",
  metadata: {
    provider: "xai",
    model: "grok-a",
    effort: Just("low"),
    duration: Duration.milliseconds(5),
    tokens: Nothing(),
  },
}

/** A stub `Llm` that records the provider and credential of every call. */
function fakeLlm(
  opts: { listModels?: () => Future<Error, ModelListing[]>; generate?: () => Future<Error, Generated> } = {}
): { llm: Llm; listed: Array<[Provider, LlmCredential]>; generated: Array<[Provider, LlmCredential]> } {
  const listed: Array<[Provider, LlmCredential]> = []
  const generated: Array<[Provider, LlmCredential]> = []
  const llm: Llm = {
    listModels: (provider, credential) => {
      listed.push([provider, credential])
      return (opts.listModels ?? (() => Future.resolve([listing()])))()
    },
    generate: (provider, credential) => {
      generated.push([provider, credential])
      return (opts.generate ?? (() => Future.resolve(okGeneration)))()
    },
  }
  return { llm, listed, generated }
}

const device = (deviceCode: string): Secret => ({ kind: "device", deviceCode })
/** Credentials that are not a sign-in: an API key, a setup token, a bare device code. */
const notSignIns: Secret[] = [{ kind: "key", key: "xai-key" }, { kind: "token", token: "t" }, device("dev-1")]
const signIn = (accessToken: string, expiresAt: POSIX = POSIX.now().addDuration(Duration.hours(1))): Secret => ({
  kind: "oauth",
  accessToken,
  refreshToken: "refresh-1",
  expiresAt,
})

describe("xaiDeviceAdapter begin and accept", () => {
  test("begin maps the device code into a challenge, an expiry and a device secret", async () => {
    clock()
    const { calls } = stubFetch()

    const begun = await run(xaiDeviceAdapter(fakeLlm().llm, "account-key").begin(route, Id.random<"AiAttempt">()))

    assert.deepEqual(begun.challenge, {
      kind: "device",
      userCode: "BB88-BABF",
      verificationUrl: "https://auth.x.ai/oauth2/device",
    })
    assert.equal(begun.expiresAt.value, T0 + 1800 * 1000)
    assert.deepEqual(begun.secret, Just({ kind: "device", deviceCode: "dev-1" }))
    assert.equal(calls(TOKEN_URL), 0)
  })

  test("a device route takes no entry, and poll wants a device secret", async () => {
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")

    assert.equal((await rejection(adapter.accept(route, "anything"))).message, "A device route takes no entry")
    assert.equal((await rejection(adapter.poll(route, signIn("access")))).message, "poll expects a device secret")
  })
})

describe("xaiDeviceAdapter poll", () => {
  test("makes no request until xAI's interval has passed", async () => {
    const at = clock()
    const { answers, calls } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")
    await run(adapter.begin(route, Id.random<"AiAttempt">()))

    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "pending" })
    at(4_999)
    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "pending" })
    assert.equal(calls(TOKEN_URL), 0)

    at(5_000)
    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "pending" })
    assert.equal(calls(TOKEN_URL), 1)

    // Every answer re-arms the gate: an early poll after the request is held back again.
    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "pending" })
    assert.equal(calls(TOKEN_URL), 1)
    at(9_999)
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 1)
    at(10_000)
    answers[TOKEN_URL] = () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 2)
  })

  test("maps denied, expired and a granted code, and forgets the sign-in once it is settled", async () => {
    const at = clock()
    const { answers, calls } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")
    await run(adapter.begin(route, Id.random<"AiAttempt">()))
    at(5_000)

    answers[TOKEN_URL] = () => json({ error: "access_denied" }, 400)
    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "denied" })
    // The gate is gone: the next poll reaches xAI at once instead of waiting out an interval.
    answers[TOKEN_URL] = () => json({ error: "expired_token" }, 400)
    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "expired" })
    answers[TOKEN_URL] = () => json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    const granted = await run(adapter.poll(route, device("dev-1")))
    assert.deepEqual(granted, {
      kind: "authorized",
      credential: {
        kind: "oauth",
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new POSIX(T0 + 5_000 + 3600 * 1000),
      },
    })
    assert.equal(calls(TOKEN_URL), 3)
    answers[TOKEN_URL] = pendingAnswer
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 4)
  })

  test("after slow_down the gate takes the interval xAI names, with no extra step on top", async () => {
    const at = clock()
    const { answers, calls } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")
    await run(adapter.begin(route, Id.random<"AiAttempt">()))
    at(5_000)
    answers[TOKEN_URL] = () => json({ error: "slow_down", interval: 12 }, 400)
    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "pending" })
    assert.equal(calls(TOKEN_URL), 1)

    at(5_000 + 11_999)
    assert.deepEqual(await run(adapter.poll(route, device("dev-1"))), { kind: "pending" })
    assert.equal(calls(TOKEN_URL), 1)

    // Exactly the 12 s xAI named: an adapter that added its own 5 s would still be waiting.
    at(5_000 + 12_000)
    answers[TOKEN_URL] = pendingAnswer
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 2)

    // A plain authorization_pending names no interval: the widened one stays.
    at(5_000 + 12_000 + 11_999)
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 2)
    at(5_000 + 12_000 + 12_000)
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 3)
  })

  test("each slow_down that names no interval adds 5 seconds to the current wait", async () => {
    const at = clock()
    const { answers, calls } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")
    await run(adapter.begin(route, Id.random<"AiAttempt">()))
    at(5_000)
    answers[TOKEN_URL] = () => json({ error: "slow_down" }, 400)
    await run(adapter.poll(route, device("dev-1")))

    at(5_000 + 9_999)
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 1)
    at(5_000 + 10_000)
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 2)

    // A second slow_down builds on the 10 s now in force, not on the default: 15 s.
    at(15_000 + 14_999)
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 2)
    at(15_000 + 15_000)
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 3)
  })

  test("a poll with no gate, as after a restart, reaches xAI once and then holds the default interval", async () => {
    const at = clock()
    const { calls } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")

    assert.deepEqual(await run(adapter.poll(route, device("dev-lost"))), { kind: "pending" })
    assert.equal(calls(TOKEN_URL), 1)
    assert.deepEqual(await run(adapter.poll(route, device("dev-lost"))), { kind: "pending" })
    assert.equal(calls(TOKEN_URL), 1)

    at(5_000)
    await run(adapter.poll(route, device("dev-lost")))
    assert.equal(calls(TOKEN_URL), 2)
  })

  test("a rejected poll reports the status and none of the body", async () => {
    const at = clock()
    const { answers } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")
    await run(adapter.begin(route, Id.random<"AiAttempt">()))
    at(5_000)
    answers[TOKEN_URL] = () => json({ error: "server_error", error_description: "internal token abc123" }, 500)

    const error = await rejection(adapter.poll(route, device("dev-1")))

    assert.equal(error.message, "xAI device token polling failed (500)")
  })

  test("beginning another sign-in drops the gates of the ones that expired", async () => {
    const at = clock()
    const { answers, calls } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")
    await run(adapter.begin(route, Id.random<"AiAttempt">()))
    at(5_000)
    // xAI asks dev-1's poller to back off for an hour, well past the 30 minutes its code lives.
    answers[TOKEN_URL] = () => json({ error: "slow_down", interval: 3600 }, 400)
    await run(adapter.poll(route, device("dev-1")))
    at(31 * 60 * 1000)
    answers[TOKEN_URL] = pendingAnswer
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 1)

    await run(adapter.begin(route, Id.random<"AiAttempt">()))
    await run(adapter.poll(route, device("dev-1")))
    assert.equal(calls(TOKEN_URL), 2)
    // The new sign-in keeps its own gate.
    await run(adapter.poll(route, device("dev-2")))
    assert.equal(calls(TOKEN_URL), 2)
  })
})

describe("xaiDeviceAdapter verify", () => {
  test("a credential that is not a sign-in is invalid, without a provider call", async () => {
    const { llm, listed, generated } = fakeLlm()
    const { calls } = stubFetch()
    const adapter = xaiDeviceAdapter(llm, "account-key")

    for (const credential of notSignIns) {
      assert.deepEqual(await run(adapter.verify(route, credential)), { kind: "failed", reason: "invalid" })
    }
    assert.equal(listed.length + generated.length, 0)
    assert.equal(calls(USERINFO_URL), 0)
  })

  test("a working sign-in verifies ready through the CLI proxy credential, with the account masked", async () => {
    const { llm, listed, generated } = fakeLlm()
    const { fetchMock } = stubFetch()

    const outcome = await run(xaiDeviceAdapter(llm, "account-key").verify(route, signIn("grok-access")))

    if (outcome.kind !== "ready") throw new Error("expected the sign-in to verify ready")
    assert.deepEqual(listed, [["xai", { kind: "xai_oauth", accessToken: "grok-access" }]])
    assert.deepEqual(generated, [["xai", { kind: "xai_oauth", accessToken: "grok-access" }]])
    assert.equal(outcome.capabilities.account, maskAccount("me@example.com"))
    assert.equal(outcome.capabilities.account.includes("me@example.com"), false)
    assert.equal(outcome.capabilities.billing, "Your xAI account")
    assert.equal(outcome.capabilities.models.find((m) => m.recommended)?.id, "grok-a")
    const [url, init] = fetchMock.mock.calls[0] ?? []
    assert.equal(url, USERINFO_URL)
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer grok-access")
  })

  test("accountId follows the account's sub, not the token, and keeps sub and email out", async () => {
    const { llm } = fakeLlm()
    const { answers } = stubFetch()
    const idFor = async (accessToken: string, sub: string, accountKey = "account-key"): Promise<string> => {
      answers[USERINFO_URL] = () => json({ sub, email: "me@example.com" })
      const outcome = await run(xaiDeviceAdapter(llm, accountKey).verify(route, signIn(accessToken)))
      if (outcome.kind !== "ready") throw new Error("expected the sign-in to verify ready")
      return outcome.accountId
    }

    const first = await idFor("token-one", "user-1")
    const rotated = await idFor("token-two", "user-1")
    const otherAccount = await idFor("token-one", "user-2")
    const otherKey = await idFor("token-one", "user-1", "another-account-key")

    assert.equal(first, rotated)
    assert.notEqual(first, otherAccount)
    assert.notEqual(first, otherKey)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(first.includes("user-1"), false)
  })

  test("an account that shares no email is shown as a plain xAI account", async () => {
    const { llm } = fakeLlm()
    const { answers } = stubFetch()
    answers[USERINFO_URL] = () => json({ sub: "user-1" })

    const outcome = await run(xaiDeviceAdapter(llm, "account-key").verify(route, signIn("grok-access")))

    if (outcome.kind !== "ready") throw new Error("expected the sign-in to verify ready")
    assert.equal(outcome.capabilities.account, "xAI account")
  })

  test("a sign-in that reaches no usable model is invalid, without a generation or a userinfo call", async () => {
    const { llm, generated } = fakeLlm({ listModels: () => Future.resolve([listing({ efforts: Just([]) })]) })
    const { calls } = stubFetch()

    const outcome = await run(xaiDeviceAdapter(llm, "account-key").verify(route, signIn("grok-access")))

    assert.deepEqual(outcome, { kind: "failed", reason: "invalid" })
    assert.equal(generated.length, 0)
    assert.equal(calls(USERINFO_URL), 0)
  })

  test("a 401 from the provider is invalid and a 402 is quota_exhausted", async () => {
    stubFetch()
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const failWith = (status: number) =>
      fakeLlm({ generate: () => Future.reject(OpenAI.APIError.generate(status, {}, "refused", new Headers())) }).llm

    const unauthorized = await run(xaiDeviceAdapter(failWith(401), "account-key").verify(route, signIn("grok-access")))
    const exhausted = await run(xaiDeviceAdapter(failWith(402), "account-key").verify(route, signIn("grok-access")))

    assert.deepEqual(unauthorized, { kind: "failed", reason: "invalid" })
    assert.deepEqual(exhausted, { kind: "failed", reason: "quota_exhausted" })
  })

  test("a userinfo lookup that fails reads as unreachable and logs the error class, never the token", async () => {
    const { answers } = stubFetch()
    answers[USERINFO_URL] = () => json({ error: "server_error" }, 503)
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined)

    const outcome = await run(xaiDeviceAdapter(fakeLlm().llm, "account-key").verify(route, signIn("secret-access")))

    assert.deepEqual(outcome, { kind: "failed", reason: "unreachable" })
    const lines = logged.mock.calls.map((args) => args.map(String).join(" "))
    assert.deepEqual(lines, ["AI verify failed for xai/device: Error"])
  })
})

describe("xaiDeviceAdapter refresh", () => {
  test("renews a sign-in that is about to lapse", async () => {
    clock()
    const { answers, fetchMock } = stubFetch()
    answers[TOKEN_URL] = () => json({ access_token: "fresh-access", refresh_token: "rotated", expires_in: 3600 })
    const lapsing = signIn("old-access", POSIX.now().addDuration(Duration.minutes(1)))

    const renewed = await run(xaiDeviceAdapter(fakeLlm().llm, "account-key").refresh(route, lapsing))

    assert.deepEqual(renewed, {
      kind: "oauth",
      accessToken: "fresh-access",
      refreshToken: "rotated",
      expiresAt: new POSIX(T0 + 3600 * 1000),
    })
    assert.equal(fetchMock.mock.calls.length, 1)
  })

  test("hands back a sign-in with time left, and any other credential, without a request", async () => {
    const { fetchMock } = stubFetch()
    const adapter = xaiDeviceAdapter(fakeLlm().llm, "account-key")
    const fresh = signIn("grok-access")

    assert.equal(await run(adapter.refresh(route, fresh)), fresh)
    for (const credential of notSignIns) {
      assert.equal(await run(adapter.refresh(route, credential)), credential)
    }
    assert.equal(fetchMock.mock.calls.length, 0)
  })
})
