export {
  type Llm,
  type LlmRequest,
  type Generated,
  type LlmMetadata,
  type TokenUsage,
  type ModelListing,
  type ProviderOutput,
  type LlmFailure,
  providerLlm,
  classifyLlmError,
  withTransientRetry,
}

import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"

import { type Provider, type Effort } from "@be/domain/ai/routes"
import { listOpenAIModels, listXaiModels, generateWithOpenAI, generateWithXai } from "@be/app/ai/llm/openai"
import { listAnthropicModels, generateWithAnthropic } from "@be/app/ai/llm/anthropic"

type LlmRequest = {
  model: string
  effort: Effort
  prompt: string
  systemInstruction: Maybe<string>
  maxOutputTokens: number
}
type TokenUsage = { input: Maybe<number>; output: Maybe<number>; total: Maybe<number> }
/** One provider call's answer. `effortSent` is false when the model refused the effort and the call ran without it. */
type ProviderOutput = { text: string; tokens: Maybe<TokenUsage>; effortSent: boolean }
type LlmMetadata = {
  provider: Provider
  model: string
  effort: Maybe<Effort>
  duration: Duration
  tokens: Maybe<TokenUsage>
}
type Generated = { text: string; metadata: LlmMetadata }
/** One model a key can reach. `Nothing` where the provider doesn't say (OpenAI, xAI). */
type ModelListing = {
  id: string
  name: string
  createdAt: POSIX
  structuredOutput: Maybe<boolean>
  efforts: Maybe<Effort[]>
}
/** What `verify` (and later, pinned work) needs from a provider; tests pass a fake. */
type Llm = {
  readonly listModels: (provider: Provider, apiKey: string) => Future<Error, ModelListing[]>
  readonly generate: (provider: Provider, apiKey: string, request: LlmRequest) => Future<Error, Generated>
}
/** Why a provider call failed, in `Readiness`'s vocabulary. */
type LlmFailure = "invalid" | "quota_exhausted" | "unreachable"

const MAX_ATTEMPTS = 3
const QUOTA = /quota|credit|billing/i
/** xAI answers a wrong key with a 400 ("Incorrect API key provided"), not a 401. */
const BAD_KEY = /(incorrect|invalid) api key/i

function statusOf(error: Error): number | undefined {
  return error instanceof OpenAI.APIError || error instanceof Anthropic.APIError ? error.status : undefined
}

function classifyLlmError(error: Error): LlmFailure {
  const status = statusOf(error)
  if (status === 402 || QUOTA.test(error.message)) return "quota_exhausted"
  if (status === 401 || status === 403 || (status === 400 && BAD_KEY.test(error.message))) return "invalid"
  return "unreachable"
}

/**
 * Retried: a connection failure or timeout, or a 408/409/429/5xx that isn't a quota. Never a 4xx about the request,
 * and never our own error (an empty answer): resending those only spends tokens again.
 */
function isTransient(error: Error): boolean {
  if (classifyLlmError(error) !== "unreachable") return false
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError) return true
  const status = statusOf(error)
  return status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500)
}

/** commit-tools `domain/llm/retry.ts` without its interactive prompt: 3 tries, 0.5 s then 1 s backoff. */
function withTransientRetry<T>(make: () => Future<Error, T>, attempt = 0): Future<Error, T> {
  return make().chainRej((error) =>
    attempt + 1 < MAX_ATTEMPTS && isTransient(error)
      ? Future.resolveAfter<Error, void>(Math.min(8_000, 500 * 2 ** attempt), undefined).chain(() =>
          withTransientRetry(make, attempt + 1)
        )
      : Future.reject(error)
  )
}

function call(provider: Provider, apiKey: string, request: LlmRequest): Future<Error, ProviderOutput> {
  switch (provider) {
    case "openai":
      return generateWithOpenAI(apiKey, request)
    case "anthropic":
      return generateWithAnthropic(apiKey, request)
    case "xai":
      return generateWithXai(apiKey, request)
    default:
      return provider satisfies never
  }
}

function list(provider: Provider, apiKey: string): Future<Error, ModelListing[]> {
  switch (provider) {
    case "openai":
      return listOpenAIModels(apiKey)
    case "anthropic":
      return listAnthropicModels(apiKey)
    case "xai":
      return listXaiModels(apiKey)
    default:
      return provider satisfies never
  }
}

const providerLlm: Llm = {
  listModels: (provider, apiKey) => withTransientRetry(() => list(provider, apiKey)),
  // The clock starts when the Future is forked, not when it's built.
  generate: (provider, apiKey, request) =>
    Future.resolve<Error, void>(undefined).chain(() => {
      const started = POSIX.now()
      return withTransientRetry(() => call(provider, apiKey, request)).map(({ text, tokens, effortSent }) => ({
        text,
        metadata: {
          provider,
          model: request.model,
          effort: effortSent ? Just(request.effort) : Nothing<Effort>(),
          duration: POSIX.now().difference(started),
          tokens,
        },
      }))
    }),
}
