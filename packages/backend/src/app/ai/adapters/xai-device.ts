export { xaiDeviceAdapter }

import { createHmac } from "node:crypto"
import { Future } from "@lib/future"
import { Just } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { type Secret, type Authorization, type Readiness, type ProviderAdapter } from "@be/domain/ai/adapter"
import { type Route } from "@be/domain/ai/routes"
import { maskAccount, billingLabel } from "@be/domain/ai/capabilities"
import { type Llm } from "@be/app/ai/llm/types"
import { failed, probeModels, verifyFailure } from "@be/app/ai/adapters/readiness"
import {
  type DevicePoll,
  DEFAULT_INTERVAL,
  requestXaiDeviceCode,
  pollXaiDeviceToken,
  ensureFreshXaiTokens,
  fetchXaiUser,
} from "@be/app/ai/auth/xai"

const SLOW_DOWN_STEP = Duration.seconds(5)

type Gate = { next: POSIX; interval: Duration; expiresAt: POSIX }

function xaiDeviceAdapter(llm: Llm, accountKey: string): ProviderAdapter {
  const gates = new Map<string, Gate>()
  return {
    begin: () =>
      requestXaiDeviceCode().map((device) => {
        prune(gates)
        gates.set(device.deviceCode, {
          next: POSIX.now().addDuration(device.interval),
          interval: device.interval,
          expiresAt: device.expiresAt,
        })
        return {
          challenge: { kind: "device", userCode: device.userCode, verificationUrl: device.verificationUri },
          expiresAt: device.expiresAt,
          secret: Just<Secret>({ kind: "device", deviceCode: device.deviceCode }),
        }
      }),
    poll: (_route, secret) => {
      if (secret.kind !== "device") return Future.reject(new Error("poll expects a device secret"))
      const gate = gates.get(secret.deviceCode)
      if (gate !== undefined && gate.next.isAfter(POSIX.now()))
        return Future.resolve<Error, Authorization>({ kind: "pending" })
      return pollXaiDeviceToken(secret.deviceCode).map((result) => settle(gates, secret.deviceCode, gate, result))
    },
    accept: () => Future.reject(new Error("A device route takes no entry")),
    verify: (route, credential) => verify(llm, accountKey, route, credential),
    refresh: (_route, credential) =>
      credential.kind === "oauth" ? ensureFreshXaiTokens(credential) : Future.resolve(credential),
  }
}

function verify(llm: Llm, accountKey: string, route: Route, credential: Secret): Future<Error, Readiness> {
  if (credential.kind !== "oauth") return Future.resolve(failed("invalid"))
  const { accessToken } = credential
  return probeModels(llm, "xai", { kind: "xai_oauth", accessToken })
    .chain((models) =>
      models.unwrap(
        () => Future.resolve<Error, Readiness>(failed("invalid")),
        (usable) =>
          fetchXaiUser(accessToken).map((user): Readiness => ({
            kind: "ready",
            accountId: createHmac("sha256", accountKey).update(`xai\nsub\n${user.sub}`).digest("hex"),
            capabilities: {
              account: user.email.map(maskAccount).withDefault("xAI account"),
              billing: billingLabel(route),
              models: usable,
            },
          }))
      )
    )
    .chainRej(verifyFailure(route))
}

function settle(
  gates: Map<string, Gate>,
  deviceCode: string,
  gate: Gate | undefined,
  result: DevicePoll
): Authorization {
  switch (result.status) {
    case "pending": {
      rearm(gates, deviceCode, gate, currentInterval(gate))
      return { kind: "pending" }
    }
    case "slow_down": {
      rearm(gates, deviceCode, gate, result.interval.withDefault(currentInterval(gate).add(SLOW_DOWN_STEP)))
      return { kind: "pending" }
    }
    case "complete":
      gates.delete(deviceCode)
      return { kind: "authorized", credential: result.tokens }
    case "denied":
    case "expired":
      gates.delete(deviceCode)
      return { kind: result.status }
    default:
      return result satisfies never
  }
}

const currentInterval = (gate: Gate | undefined): Duration => (gate === undefined ? DEFAULT_INTERVAL : gate.interval)

function rearm(gates: Map<string, Gate>, deviceCode: string, gate: Gate | undefined, interval: Duration): void {
  const next = POSIX.now().addDuration(interval)
  gates.set(deviceCode, { next, interval, expiresAt: gate === undefined ? next : gate.expiresAt })
}

function prune(gates: Map<string, Gate>): void {
  const now = POSIX.now()
  for (const [deviceCode, gate] of gates) {
    if (!gate.expiresAt.isAfter(now)) gates.delete(deviceCode)
  }
}
