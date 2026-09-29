export { apiKeyAdapter }

import { createHmac } from "node:crypto"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX } from "@lib/time"
import { type Route } from "@be/domain/ai/routes"
import { billingLabel } from "@be/domain/ai/capabilities"
import { type Secret, type Readiness, type ProviderAdapter } from "@be/domain/ai/adapter"
import { checkApiKey } from "@be/domain/ai/keys"
import { type Llm } from "@be/app/ai/llm/types"
import { ENTRY_EXPIRY, failed, probeModels, verifyFailure } from "@be/app/ai/adapters/readiness"

function apiKeyAdapter(llm: Llm, accountKey: string): ProviderAdapter {
  return {
    begin: () =>
      Future.resolve({
        challenge: { kind: "entry" },
        expiresAt: POSIX.now().addDuration(ENTRY_EXPIRY),
        secret: Nothing(),
      }),
    poll: () => Future.reject(new Error("An API-key route has nothing to poll")),
    accept: (_route, entered) => Future.resolve({ kind: "key", key: entered.trim() }),
    verify: (route, credential) => verify(llm, accountKey, route, credential),
    refresh: (_route, credential) => Future.resolve(credential),
  }
}

function verify(llm: Llm, accountKey: string, route: Route, credential: Secret): Future<Error, Readiness> {
  const { provider } = route
  if (credential.kind !== "key" || checkApiKey(provider, credential.key) instanceof Just)
    return Future.resolve(failed("invalid"))
  const key = credential.key
  return probeModels(llm, provider, { kind: "api_key", key })
    .map((models) =>
      models.unwrap<Readiness>(
        () => failed("invalid"),
        (usable) => ({
          kind: "ready",
          accountId: createHmac("sha256", accountKey).update(`${provider}\n${key}`).digest("hex"),
          capabilities: { account: `API key …${key.slice(-4)}`, billing: billingLabel(route), models: usable },
        })
      )
    )
    .chainRej(verifyFailure(route))
}
