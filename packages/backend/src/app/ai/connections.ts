export { type AiConnections, aiConnectionsFromEnv, routeMode }

import { type Maybe, Just, Nothing } from "@lib/maybe"
import { Failure, Success } from "@lib/result"
import { Postgres } from "@be/lib/postgres"

import { type Route, type RouteMode, type RouteView, isLiveRoute, routeViews } from "@be/domain/ai/routes"
import { type ProviderAdapter } from "@be/domain/ai/adapter"
import { vaultKeys } from "@be/app/ai/crypto"
import { FakeProvider, testAdapter } from "@be/app/ai/testAdapter"
import { apiKeyAdapter } from "@be/app/ai/apiKeyAdapter"
import { providerLlm } from "@be/app/ai/llm/router"

import { type SecretVault, postgresVault } from "@be/app/ai/vault"
import { type Attempts, postgresAttempts } from "@be/app/ai/attempts"
import env from "@be/app/environment"

/** The service commands receive: routes to offer, the adapter behind each, the credential vault, and the attempt log. */
type AiConnections = {
  readonly routes: RouteView[]
  /** `Nothing` = unproven: no adapter serves this route. */
  readonly adapter: (route: Route) => Maybe<ProviderAdapter>
  readonly vault: SecretVault
  readonly attempts: Attempts
  readonly fakeProvider: Maybe<FakeProvider>
}

/** Dev fallback for `AI_ACCOUNT_KEY`; production refuses it and leaves the API-key routes `unproven`. */
const DEV_ACCOUNT_KEY = "job-kit-ai:ai-account-id:development"

function accountKeyFromEnv(): Maybe<string> {
  if (env.AI_ACCOUNT_KEY !== "") return Just(env.AI_ACCOUNT_KEY)
  return env.NODE_ENV === "production" ? Nothing() : Just(DEV_ACCOUNT_KEY)
}

/** One answer for both `aiConnectionsFromEnv` and the `getSetup` query, so the offered routes match the served ones. */
function routeMode(): RouteMode {
  if (env.AI_TEST_ADAPTER === "on") return "test"
  const vaultReady = vaultKeys(env.AI_CREDENTIAL_KEYS, env.NODE_ENV) instanceof Success
  return vaultReady && accountKeyFromEnv() instanceof Just ? "live" : "off"
}

/**
 * `AI_TEST_ADAPTER=on` serves every route through the in-memory test adapter and mounts its fake provider (refused
 * outright in production); otherwise API-key routes get the real adapter once the vault and account keys are set.
 */
function aiConnectionsFromEnv(postgres: Postgres): AiConnections {
  const mode = routeMode()
  if (mode === "test" && env.NODE_ENV === "production") throw new Error("AI_TEST_ADAPTER must be off in production")

  const fake = mode === "test" ? Just(new FakeProvider(env.APP_URL)) : Nothing<FakeProvider>()
  const keys = vaultKeys(env.AI_CREDENTIAL_KEYS, env.NODE_ENV)
  // Boot anyway: no route is ready without a key, and the log says why every vault call fails.
  if (keys instanceof Failure) console.error(`AI credential vault disabled: ${keys.error}`)
  const accountKey = accountKeyFromEnv()
  if (accountKey instanceof Nothing) console.error("AI API-key routes disabled: AI_ACCOUNT_KEY is not set")
  const live = accountKey.map((key) => apiKeyAdapter(providerLlm, key))

  return {
    routes: routeViews(mode),
    adapter: (route) =>
      mode === "test" ? fake.map(testAdapter) : mode === "live" && isLiveRoute(route) ? live : Nothing(),
    vault: postgresVault(postgres, keys),
    attempts: postgresAttempts(postgres),
    fakeProvider: fake,
  }
}
