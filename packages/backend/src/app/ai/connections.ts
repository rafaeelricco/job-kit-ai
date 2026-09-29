export { type AiConnections, aiConnectionsFromEnv, routeMode }

import { type Maybe, Just, Nothing } from "@lib/maybe"
import { type Result, Failure, Success } from "@lib/result"
import { Postgres } from "@be/lib/postgres"
import { type Route, type RouteMode, type RouteView, isLiveRoute, routeViews } from "@be/domain/ai/routes"
import { type ProviderAdapter } from "@be/domain/ai/adapter"
import { type VaultKeys, vaultKeys } from "@be/app/ai/store/crypto"
import { FakeProvider, testAdapter } from "@tests/support/test-provider/adapter"
import { apiKeyAdapter } from "@be/app/ai/adapters/api-key"
import { xaiDeviceAdapter } from "@be/app/ai/adapters/xai-device"
import { providerLlm } from "@be/app/ai/llm/router"
import { type SecretVault, postgresVault } from "@be/app/ai/store/vault"
import { type Attempts, postgresAttempts } from "@be/app/ai/store/attempts"

import env from "@be/app/environment"

type AiConnections = {
  readonly routes: RouteView[]
  readonly adapter: (route: Route) => Maybe<ProviderAdapter>
  readonly vault: SecretVault
  readonly attempts: Attempts
  readonly fakeProvider: Maybe<FakeProvider>
}

const DEV_ACCOUNT_KEY = "job-kit-ai:ai-account-id:development"

function accountKeyFromEnv(): Maybe<string> {
  if (env.AI_ACCOUNT_KEY !== "") return Just(env.AI_ACCOUNT_KEY)
  return env.NODE_ENV === "production" ? Nothing() : Just(DEV_ACCOUNT_KEY)
}

const modeOf = (testAdapterOn: boolean, keys: Result<string, VaultKeys>, accountKey: Maybe<string>): RouteMode =>
  testAdapterOn ? "test" : keys instanceof Success && accountKey instanceof Just ? "live" : "off"

function routeMode(): RouteMode {
  return modeOf(env.AI_TEST_ADAPTER === "on", vaultKeys(env.AI_CREDENTIAL_KEYS, env.NODE_ENV), accountKeyFromEnv())
}

function aiConnectionsFromEnv(postgres: Postgres): AiConnections {
  const keys = vaultKeys(env.AI_CREDENTIAL_KEYS, env.NODE_ENV)
  const accountKey = accountKeyFromEnv()
  const mode = modeOf(env.AI_TEST_ADAPTER === "on", keys, accountKey)
  if (mode === "test" && env.NODE_ENV === "production") throw new Error("AI_TEST_ADAPTER must be off in production")

  const fake = mode === "test" ? Just(new FakeProvider(env.APP_URL)) : Nothing<FakeProvider>()
  if (keys instanceof Failure) console.error(`AI credential vault disabled: ${keys.error}`)
  if (accountKey instanceof Nothing) console.error("AI live routes disabled: AI_ACCOUNT_KEY is not set")
  const apiKeys = accountKey.map((key) => apiKeyAdapter(providerLlm, key))
  const xaiDevice = accountKey.map((key) => xaiDeviceAdapter(providerLlm, key))
  const live = (route: Route): Maybe<ProviderAdapter> =>
    !isLiveRoute(route) ? Nothing() : route.method === "api_key" ? apiKeys : xaiDevice

  return {
    routes: routeViews(mode),
    adapter: (route) => (mode === "test" ? fake.map(testAdapter) : mode === "live" ? live(route) : Nothing()),
    vault: postgresVault(postgres, keys),
    attempts: postgresAttempts(postgres),
    fakeProvider: fake,
  }
}
