export { FakeProvider, testAdapter, type GrantSummary, type GrantStatus }

import { randomBytes, randomInt, createHash } from "node:crypto"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { POSIX, Duration } from "@lib/time"

import { type Route, type Provider, type Method } from "@be/domain/ai/routes"
import { type Model, type Capabilities } from "@be/domain/ai/capabilities"
import { type Secret, type Authorization, type Readiness, type ProviderAdapter } from "@be/domain/ai/adapter"
import { API_KEY_BILLING } from "@be/app/ai/apiKeyAdapter"

/** Unambiguous: no `I`, `O`, or digits that could be misread as either. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"

const DEVICE_EXPIRY = Duration.minutes(15)
const ENTRY_EXPIRY = Duration.minutes(10)
const DEFAULT_ACCOUNT = "tester@example.test"

type GrantStatus = "ok" | "revoked" | "expired" | "quota" | "invalid" | "slow"

/** One issued credential: keyed internally by its raw value, never exposed as such. */
type Grant = { id: string; token: string; provider: Provider; method: Method; account: string; status: GrantStatus }

/** What the `/grants` page shows: enough to identify and act on a credential, never the token itself. */
type GrantSummary = { id: string; provider: Provider; method: Method; account: string; status: GrantStatus }

type DeviceStatus = "pending" | "approved" | "denied" | "expired"
type DeviceEntry = {
  deviceCode: string
  provider: Provider
  status: DeviceStatus
  account: string
  quota: boolean
  token: string | null
}

type CheckOutcome = { settled: true; readiness: Readiness } | { settled: false }

function randomToken(): string {
  return randomBytes(32).toString("base64url")
}

function randomUserCode(): string {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] ?? "A").join("")
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

/** `"tester@example.test"` → `"t•••@example.test"`. */
function maskAccount(account: string): string {
  const at = account.indexOf("@")
  if (at <= 0) return "•••"
  return `${account.slice(0, 1)}•••${account.slice(at)}`
}

function accountId(provider: Provider, account: string): string {
  return createHash("sha256").update(`${provider}:${account}`).digest("hex")
}

const SUBSCRIPTION_BILLING: Record<Provider, string> = {
  openai: "Your ChatGPT plan",
  anthropic: "Your Claude subscription",
  xai: "Your xAI account",
}

function billingFor(route: Route): string {
  return route.method === "api_key" ? API_KEY_BILLING[route.provider] : SUBSCRIPTION_BILLING[route.provider]
}

const MODELS: Model[] = [
  {
    id: "test-a",
    summary: "Works with every Job Kit task",
    recommended: true,
    efforts: ["low", "medium", "high"],
    usable: true,
    reason: null,
  },
  {
    id: "test-b",
    summary: "Faster, shorter answers",
    recommended: false,
    efforts: ["low", "medium"],
    usable: true,
    reason: null,
  },
  { id: "test-c", summary: "Most capable, slowest", recommended: false, efforts: ["high"], usable: true, reason: null },
  {
    id: "test-d",
    summary: "Not usable for Job Kit",
    recommended: false,
    efforts: [],
    usable: false,
    reason: "No structured output, can't draft profiles",
  },
]

function capabilitiesFor(route: Route, account: string): Capabilities {
  return { account: maskAccount(account), billing: billingFor(route), models: MODELS }
}

/**
 * Stands in for a provider's servers: device codes, issued tokens, and their later fate. Process memory only; a restart
 * forgets every grant, so stored test credentials then verify as `revoked`, which is itself a useful state. Nothing here
 * ever logs.
 */
class FakeProvider {
  private readonly appUrl: string
  private readonly devices = new Map<string, DeviceEntry>() // userCode -> entry
  private readonly deviceCodes = new Map<string, string>() // deviceCode -> userCode
  private readonly grants_ = new Map<string, Grant>() // credential value -> grant

  constructor(appUrl: string) {
    this.appUrl = appUrl
  }

  /** Start a device flow: a fresh user code and device secret, pending until the `/device` page decides it. */
  beginDevice(provider: Provider): { userCode: string; deviceCode: string; verificationUrl: string; expiresAt: POSIX } {
    const userCode = randomUserCode()
    const deviceCode = randomToken()
    this.devices.set(userCode, {
      deviceCode,
      provider,
      status: "pending",
      account: DEFAULT_ACCOUNT,
      quota: false,
      token: null,
    })
    this.deviceCodes.set(deviceCode, userCode)
    return {
      userCode,
      deviceCode,
      verificationUrl: new URL("/api/dev/test-provider/device", this.appUrl).href,
      expiresAt: POSIX.now().addDuration(DEVICE_EXPIRY),
    }
  }

  /** The device secret's current fate; issues (and thereafter remembers) a token once approved. */
  pollDevice(deviceCode: string, route: Route): Authorization {
    const userCode = this.deviceCodes.get(deviceCode)
    const entry = userCode === undefined ? undefined : this.devices.get(userCode)
    if (entry === undefined) return { kind: "expired" }
    if (entry.status === "pending") return { kind: "pending" }
    if (entry.status === "denied") return { kind: "denied" }
    if (entry.status === "expired") return { kind: "expired" }
    if (entry.token === null) {
      entry.token = randomToken()
      this.registerGrant(entry.token, route.provider, route.method, entry.account, entry.quota ? "quota" : "ok")
    }
    return { kind: "authorized", credential: { kind: "token", token: entry.token } }
  }

  /** The `/device` page's decision: approve (optionally at a usage limit), deny, or expire a user code. */
  decideDevice(
    userCode: string,
    outcome: "approve" | "approve_quota" | "deny" | "expire",
    account: string
  ): Result<string, void> {
    const entry = this.devices.get(userCode)
    if (entry === undefined) return Failure("Unknown or expired code")
    if (outcome === "deny") entry.status = "denied"
    else if (outcome === "expire") entry.status = "expired"
    else {
      entry.status = "approved"
      entry.account = account.trim() === "" ? DEFAULT_ACCOUNT : account
      entry.quota = outcome === "approve_quota"
    }
    return Success(undefined)
  }

  /**
   * A pasted setup token or API key. Never fails: the entered value becomes the credential itself, and a grant is
   * registered for it whose status comes from magic words in what was typed — blank or "invalid", "quota", "slow" (verify
   * never answers), "other" (a different account) — else it verifies fine as `key-owner@example.test`.
   */
  accept(route: Route, entered: string): Secret {
    const lower = entered.toLowerCase()
    const status: GrantStatus =
      lower.trim() === "" || lower.includes("invalid")
        ? "invalid"
        : lower.includes("quota")
          ? "quota"
          : lower.includes("slow")
            ? "slow"
            : "ok"
    const account = lower.includes("other") ? "other@example.test" : "key-owner@example.test"
    this.registerGrant(entered, route.provider, route.method, account, status)
    return route.method === "setup_token" ? { kind: "token", token: entered } : { kind: "key", key: entered }
  }

  /** The readiness a credential reports today; `settled: false` models a provider that never answers. */
  check(route: Route, credential: Secret): CheckOutcome {
    if (credential.kind === "device") return { settled: true, readiness: { kind: "failed", reason: "invalid" } }
    const value = credential.kind === "token" ? credential.token : credential.key
    const grant = this.grants_.get(value)
    if (grant === undefined) return { settled: true, readiness: { kind: "failed", reason: "revoked" } }
    switch (grant.status) {
      case "slow":
        return { settled: false }
      case "invalid":
        return { settled: true, readiness: { kind: "failed", reason: "invalid" } }
      case "revoked":
        return { settled: true, readiness: { kind: "failed", reason: "revoked" } }
      case "expired":
        return { settled: true, readiness: { kind: "failed", reason: "expired" } }
      case "quota":
        return { settled: true, readiness: { kind: "failed", reason: "quota_exhausted" } }
      case "ok":
        return {
          settled: true,
          readiness: {
            kind: "ready",
            accountId: accountId(route.provider, grant.account),
            capabilities: capabilitiesFor(route, grant.account),
          },
        }
      default:
        return grant.status satisfies never
    }
  }

  /** The `/grants` page's list: short id, never the token. */
  grants(): GrantSummary[] {
    return [...this.grants_.values()].map((g) => ({
      id: g.id,
      provider: g.provider,
      method: g.method,
      account: maskAccount(g.account),
      status: g.status,
    }))
  }

  /** The `/grants` page's actions: revoke, expire, exhaust, or restore a previously issued credential. */
  setGrant(id: string, status: "ok" | "revoked" | "expired" | "quota"): Result<string, void> {
    const grant = [...this.grants_.values()].find((g) => g.id === id)
    if (grant === undefined) return Failure("Unknown grant")
    grant.status = status
    return Success(undefined)
  }

  private registerGrant(token: string, provider: Provider, method: Method, account: string, status: GrantStatus): void {
    const id = createHash("sha256").update(token).digest("hex").slice(0, 8)
    this.grants_.set(token, { id, token, provider, method, account, status })
  }
}

/** Translate the `ProviderAdapter` contract onto one `FakeProvider`. */
function testAdapter(fake: FakeProvider): ProviderAdapter {
  return {
    begin: (route, _attemptId) => {
      switch (route.method) {
        case "device": {
          const { userCode, verificationUrl, expiresAt, deviceCode } = fake.beginDevice(route.provider)
          return Future.resolve({
            challenge: { kind: "device", userCode, verificationUrl },
            expiresAt,
            secret: Just({ kind: "device", deviceCode }),
          })
        }
        case "setup_token":
        case "api_key":
          return Future.resolve({
            challenge: { kind: "entry" },
            expiresAt: POSIX.now().addDuration(ENTRY_EXPIRY),
            secret: Nothing(),
          })
      }
    },
    poll: (route, secret) =>
      secret.kind === "device"
        ? Future.resolve(fake.pollDevice(secret.deviceCode, route))
        : Future.reject(new Error("poll expects a device secret")),
    accept: (route, entered) => Future.resolve(fake.accept(route, entered)),
    verify: (route, credential) => {
      const outcome = fake.check(route, credential)
      return outcome.settled ? Future.resolve(outcome.readiness) : Future.create<Error, Readiness>(() => undefined)
    },
  }
}
