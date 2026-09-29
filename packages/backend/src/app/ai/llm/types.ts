export {
  type Llm,
  type LlmCredential,
  type LlmRequest,
  type Generated,
  type TokenUsage,
  type ModelListing,
  type ProviderOutput,
  LLM_TIMEOUT_MS,
}

import { type Future } from "@lib/future"
import { type Maybe } from "@lib/maybe"
import { type POSIX, type Duration } from "@lib/time"
import { type Provider, type Effort } from "@be/domain/ai/routes"

/** The request timeout every provider client uses. */
const LLM_TIMEOUT_MS = 120_000

type LlmRequest = {
  model: string
  effort: Effort
  prompt: string
  systemInstruction: Maybe<string>
  maxOutputTokens: number
}
type TokenUsage = { input: Maybe<number>; output: Maybe<number>; total: Maybe<number> }
/** A provider call's raw answer. `text` is unchecked; `providerLlm` trims it and rejects an empty one. */
type ProviderOutput = { text: Maybe<string>; tokens: Maybe<TokenUsage>; effortSent: boolean }
type LlmMetadata = {
  provider: Provider
  model: string
  effort: Maybe<Effort>
  duration: Duration
  tokens: Maybe<TokenUsage>
}
type Generated = { text: string; metadata: LlmMetadata }
type ModelListing = {
  id: string
  name: string
  createdAt: POSIX
  structuredOutput: Maybe<boolean>
  efforts: Maybe<Effort[]>
}
type LlmCredential = { kind: "api_key"; key: string } | { kind: "xai_oauth"; accessToken: string }
type Llm = {
  readonly listModels: (provider: Provider, credential: LlmCredential) => Future<Error, ModelListing[]>
  readonly generate: (provider: Provider, credential: LlmCredential, request: LlmRequest) => Future<Error, Generated>
}
