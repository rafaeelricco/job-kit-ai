export { providerLlm }

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { POSIX } from "@lib/time"
import { type Provider, type Effort } from "@be/domain/ai/routes"
import {
  type Llm,
  type LlmCredential,
  type LlmRequest,
  type ModelListing,
  type ProviderOutput,
} from "@be/app/ai/llm/types"
import { withTransientRetry } from "@be/app/ai/llm/retry"
import { listXaiModels, generateWithXai, xaiClientOptions } from "@be/app/ai/llm/xai"
import { listAnthropicModels, generateWithAnthropic } from "@be/app/ai/llm/anthropic"

const unsupportedAuth = <T>(provider: Provider, credential: LlmCredential): Future<Error, T> =>
  Future.reject(new Error(`Unsupported auth method for ${provider}: ${credential.kind}`))

/** Trims a provider's text and rejects an empty answer, so no caller receives a blank response. */
function extractResponse(text: Maybe<string>): Future<Error, string> {
  return text
    .map((s) => s.trim())
    .chain((s) => (s === "" ? Nothing<string>() : Just(s)))
    .unwrap(
      () => Future.reject<Error, string>(new Error("Provider returned an empty response")),
      (s) => Future.resolve<Error, string>(s)
    )
}

function call(provider: Provider, credential: LlmCredential, request: LlmRequest): Future<Error, ProviderOutput> {
  switch (provider) {
    case "anthropic":
      return credential.kind === "api_key"
        ? generateWithAnthropic(credential.key, request)
        : unsupportedAuth(provider, credential)
    case "xai":
      return generateWithXai(xaiClientOptions(credential), request)
    default:
      return provider satisfies never
  }
}

function list(provider: Provider, credential: LlmCredential): Future<Error, ModelListing[]> {
  switch (provider) {
    case "anthropic":
      return credential.kind === "api_key" ? listAnthropicModels(credential.key) : unsupportedAuth(provider, credential)
    case "xai":
      return listXaiModels(xaiClientOptions(credential))
    default:
      return provider satisfies never
  }
}

const providerLlm: Llm = {
  listModels: (provider, credential) => withTransientRetry(() => list(provider, credential)),
  generate: (provider, credential, request) =>
    Future.resolve<Error, void>(undefined).chain(() => {
      const started = POSIX.now()
      return withTransientRetry(() => call(provider, credential, request)).chain(({ text, tokens, effortSent }) =>
        extractResponse(text).map((clean) => ({
          text: clean,
          metadata: {
            provider,
            model: request.model,
            effort: effortSent ? Just(request.effort) : Nothing<Effort>(),
            duration: POSIX.now().difference(started),
            tokens,
          },
        }))
      )
    }),
}
