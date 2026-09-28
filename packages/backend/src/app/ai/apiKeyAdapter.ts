export { apiKeyAdapter, API_KEY_BILLING }

import { createHmac } from "node:crypto"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"

import { type Provider, EFFORTS } from "@be/domain/ai/routes"
import { type Model } from "@be/domain/ai/capabilities"
import { type Secret, type ReadinessFailure, type Readiness, type ProviderAdapter } from "@be/domain/ai/adapter"
import { checkApiKey } from "@be/domain/ai/keys"
import { type Llm, type ModelListing, classifyLlmError } from "@be/app/ai/llm/router"

const ENTRY_EXPIRY = Duration.minutes(10)
const VERIFY_PROMPT = "Reply with the single word OK."
/** Roomy enough that a model reasoning at low effort still leaves text; the call is bounded by `VERIFY_TIMEOUT` anyway. */
const VERIFY_MAX_TOKENS = 4096

const API_KEY_BILLING: Record<Provider, string> = {
  openai: "Your OpenAI API account",
  anthropic: "Your Anthropic API account",
  xai: "Your xAI API account",
}

/** The only real `ProviderAdapter`. It serves `api_key` routes, so there is never anything to `poll`. */
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
    verify: (route, credential) => verify(llm, accountKey, route.provider, credential),
  }
}

const failed = (reason: ReadinessFailure): Readiness => ({ kind: "failed", reason })

/**
 * The readiness proof: list the key's models, then one small real generation on the recommended one. Every failure
 * resolves (never rejects): a rejection would reach the user as `unreachable` through `boundedVerify`, hiding a bad
 * key or an exhausted quota.
 */
function verify(llm: Llm, accountKey: string, provider: Provider, credential: Secret): Future<Error, Readiness> {
  if (credential.kind !== "key" || checkApiKey(provider, credential.key) instanceof Just)
    return Future.resolve(failed("invalid"))
  const key = credential.key
  return llm
    .listModels(provider, key)
    .map(toModels)
    .chain((models) => {
      const target = models.find((m) => m.recommended)
      // A key that reaches no usable model can't do Job Kit's work: report it as not accepted.
      if (target === undefined) return Future.resolve<Error, Readiness>(failed("invalid"))
      return llm
        .generate(provider, key, {
          model: target.id,
          effort: target.efforts[0] ?? "low",
          prompt: VERIFY_PROMPT,
          systemInstruction: Nothing(),
          maxOutputTokens: VERIFY_MAX_TOKENS,
        })
        .map((): Readiness => ({
          kind: "ready",
          accountId: createHmac("sha256", accountKey).update(`${provider}\n${key}`).digest("hex"),
          capabilities: { account: `API key …${key.slice(-4)}`, billing: API_KEY_BILLING[provider], models },
        }))
    })
    .chainRej((error) => {
      // Only the class (SDK errors leave `name` as "Error"): a provider message may echo the key.
      console.error(`AI verify failed for ${provider}/api_key: ${error.constructor.name}`)
      return Future.resolve<Error, Readiness>(failed(classifyLlmError(error)))
    })
}

/** `structuredOutput` isn't reported `false`, and the (defaulted) effort list isn't empty. */
function isUsable(l: ModelListing): boolean {
  const structuredOk = !(l.structuredOutput instanceof Just && l.structuredOutput.value === false)
  return structuredOk && l.efforts.withDefault([...EFFORTS]).length > 0
}

function unusableReason(l: ModelListing): string | null {
  if (l.structuredOutput instanceof Just && l.structuredOutput.value === false)
    return "No structured output, can't draft profiles"
  if (l.efforts.withDefault([...EFFORTS]).length === 0) return "No reasoning-effort control"
  return null
}

/** Newest first. Recommended = the newest usable model, so no model id is ever hard-coded. */
function toModels(listings: ModelListing[]): Model[] {
  const sorted = [...listings].sort((a, b) => b.createdAt.value - a.createdAt.value)
  const recommended = sorted.find(isUsable)
  return sorted.map((l) => ({
    id: l.id,
    summary: l.name === l.id ? "" : l.name,
    recommended: l === recommended,
    efforts: l.efforts.withDefault([...EFFORTS]),
    usable: isUsable(l),
    reason: unusableReason(l),
  }))
}
