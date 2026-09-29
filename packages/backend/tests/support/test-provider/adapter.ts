export { FakeProvider, testAdapter, type DeviceOutcome, type GrantOutcome }

import { randomBytes, randomInt, createHash } from "node:crypto"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { POSIX, Duration } from "@lib/time"
import { type Route, type Provider, type Method } from "@be/domain/ai/routes"
import { type Model, type Capabilities, maskAccount, billingLabel } from "@be/domain/ai/capabilities"
import { type Secret, type Authorization, type Readiness, type ProviderAdapter } from "@be/domain/ai/adapter"
import { ENTRY_EXPIRY } from "@be/app/ai/adapters/readiness"

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"

const DEVICE_EXPIRY = Duration.minutes(15)
const DEFAULT_ACCOUNT = "tester@example.test"

type GrantStatus = "ok" | "revoked" | "expired" | "quota" | "invalid" | "slow"

type Grant = { id: string; provider: Provider; method: Method; account: string; status: GrantStatus }

type DeviceOutcome = "approve" | "approve_quota" | "deny" | "expire"
type GrantOutcome = "ok" | "revoked" | "expired" | "quota"

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

function accountId(provider: Provider, account: string): string {
  return createHash("sha256").update(`${provider}:${account}`).digest("hex")
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
  return { account: maskAccount(account), billing: billingLabel(route), models: MODELS }
}

class FakeProvider {
  private readonly appUrl: string
  private readonly devices = new Map<string, DeviceEntry>()
  private readonly deviceCodes = new Map<string, string>()
  private readonly grants_ = new Map<string, Grant>()

  constructor(appUrl: string) {
    this.appUrl = appUrl
  }

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

  decideDevice(userCode: string, outcome: DeviceOutcome, account: string): Result<string, void> {
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

  check(route: Route, credential: Secret): CheckOutcome {
    if (credential.kind === "device" || credential.kind === "oauth")
      return { settled: true, readiness: { kind: "failed", reason: "invalid" } }
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

  /** Accounts are masked. */
  grants(): Grant[] {
    return [...this.grants_.values()].map((g) => ({
      id: g.id,
      provider: g.provider,
      method: g.method,
      account: maskAccount(g.account),
      status: g.status,
    }))
  }

  setGrant(id: string, status: GrantOutcome): Result<string, void> {
    const grant = [...this.grants_.values()].find((g) => g.id === id)
    if (grant === undefined) return Failure("Unknown grant")
    grant.status = status
    return Success(undefined)
  }

  private registerGrant(token: string, provider: Provider, method: Method, account: string, status: GrantStatus): void {
    const id = createHash("sha256").update(token).digest("hex").slice(0, 8)
    this.grants_.set(token, { id, provider, method, account, status })
  }
}

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
    refresh: (_route, credential) => Future.resolve(credential),
  }
}
