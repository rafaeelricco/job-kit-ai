export { listXaiModels, generateWithXai, xaiClientOptions }

import OpenAI, { type ClientOptions } from "openai"
import { Future } from "@lib/future"
import { Just, Nothing, fromOptional } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"
import { type Effort, PROVIDER_EFFORTS } from "@be/domain/ai/routes"
import {
  type LlmCredential,
  type LlmRequest,
  type ProviderOutput,
  type TokenUsage,
  type ModelListing,
  LLM_TIMEOUT_MS,
} from "@be/app/ai/llm/types"

const XAI_API_BASE_URL = "https://api.x.ai/v1"
const XAI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1"
const XAI_CLIENT_VERSION = "1.0.41"

function xaiClientOptions(credential: LlmCredential): ClientOptions {
  switch (credential.kind) {
    case "api_key":
      return { baseURL: XAI_API_BASE_URL, apiKey: credential.key, maxRetries: 0, timeout: LLM_TIMEOUT_MS }
    case "xai_oauth":
      return {
        baseURL: XAI_PROXY_BASE_URL,
        apiKey: credential.accessToken,
        defaultHeaders: { "X-XAI-Token-Auth": "xai-grok-cli", "x-grok-client-version": XAI_CLIENT_VERSION },
        maxRetries: 0,
        timeout: LLM_TIMEOUT_MS,
      }
    default:
      return credential satisfies never
  }
}

const XAI_TEXT = /^grok-/
const NOT_TEXT = /(audio|realtime|tts|transcribe|search|image|imagine|video|embedding|moderation|instruct)/

function listXaiModels(options: ClientOptions): Future<Error, ModelListing[]> {
  return Future.attemptP(async () => {
    const out: ModelListing[] = []
    const client = new OpenAI(options)
    for await (const m of client.models.list()) {
      if (!XAI_TEXT.test(m.id) || NOT_TEXT.test(m.id)) continue
      out.push({
        id: m.id,
        name: m.id,
        createdAt: POSIX.fromDuration(Duration.seconds(Number.isFinite(m.created) ? m.created : 0)),
        structuredOutput: Nothing(),
        efforts: Nothing(),
      })
    }
    return out
  })
}

const toTokenUsage = (usage: OpenAI.CompletionUsage): TokenUsage => ({
  input: Just(usage.prompt_tokens),
  output: Just(usage.completion_tokens),
  total: Just(usage.total_tokens),
})

const buildMessages = (r: LlmRequest): OpenAI.Chat.ChatCompletionMessageParam[] =>
  r.systemInstruction.maybe<OpenAI.Chat.ChatCompletionMessageParam[]>(
    [{ role: "user", content: r.prompt }],
    (instruction) => [
      { role: "system", content: instruction },
      { role: "user", content: r.prompt },
    ]
  )

const isXaiEffort = (e: Effort): e is (typeof PROVIDER_EFFORTS.xai)[number] => PROVIDER_EFFORTS.xai.some((x) => x === e)

function buildParams(r: LlmRequest, withEffort: boolean): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const core: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model: r.model,
    messages: buildMessages(r),
    max_completion_tokens: r.maxOutputTokens,
  }
  return withEffort && isXaiEffort(r.effort) ? { ...core, reasoning_effort: r.effort } : core
}

const isOutdatedClient = (error: Error): boolean => error instanceof OpenAI.APIError && error.status === 426

const isUnsupportedEffort = (error: unknown): boolean =>
  error instanceof OpenAI.BadRequestError && /reasoning_effort/i.test(error.message)

function withEffortFallback<T>(
  run: (withEffort: boolean) => Promise<T>
): Future<Error, { value: T; effortSent: boolean }> {
  return Future.attemptP(() =>
    run(true)
      .then((value) => ({ value, effortSent: true }))
      .catch((error: unknown) => {
        if (!isUnsupportedEffort(error)) throw error
        return run(false).then((value) => ({ value, effortSent: false }))
      })
  )
}

function generateWithXai(options: ClientOptions, r: LlmRequest): Future<Error, ProviderOutput> {
  const client = new OpenAI(options)
  return withEffortFallback((withEffort) => client.chat.completions.create(buildParams(r, withEffort)))
    .mapRej((error) => {
      if (isOutdatedClient(error)) console.error("xAI rejected XAI_CLIENT_VERSION: bump it in src/app/ai/llm/xai.ts")
      return error
    })
    .map(({ value: completion, effortSent }) => ({
      text: fromOptional(completion.choices[0]?.message?.content ?? undefined),
      tokens: fromOptional(completion.usage).map(toTokenUsage),
      effortSent,
    }))
}
