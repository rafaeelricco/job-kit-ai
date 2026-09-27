export { listOpenAIModels, listXaiModels, generateWithOpenAI, generateWithXai }

import OpenAI from "openai"

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing, fromOptional } from "@lib/maybe"
import { POSIX, Duration } from "@lib/time"

import { type LlmRequest, type ProviderOutput, type TokenUsage, type ModelListing } from "@be/app/ai/llm/router"

// plain ms: SDK option
const TIMEOUT_MS = 120_000
const XAI_BASE_URL = "https://api.x.ai/v1"
const OPENAI_TEXT = /^(gpt-|o\d)/
const XAI_TEXT = /^grok-/
const NOT_TEXT = /(audio|realtime|tts|transcribe|search|image|imagine|video|embedding|moderation|instruct)/

// maxRetries 0: withTransientRetry owns retries.
const openai = (apiKey: string) => new OpenAI({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS })
const xai = (apiKey: string) => new OpenAI({ apiKey, baseURL: XAI_BASE_URL, maxRetries: 0, timeout: TIMEOUT_MS })

function listText(client: OpenAI, family: RegExp): Future<Error, ModelListing[]> {
  return Future.attemptP(async () => {
    const out: ModelListing[] = []
    for await (const m of client.models.list()) {
      if (!family.test(m.id) || NOT_TEXT.test(m.id)) continue
      out.push({
        id: m.id,
        name: m.id,
        createdAt: POSIX.fromDuration(Duration.seconds(m.created)),
        structuredOutput: Nothing(),
        efforts: Nothing(),
      })
    }
    return out
  })
}
const listOpenAIModels = (apiKey: string) => listText(openai(apiKey), OPENAI_TEXT)
const listXaiModels = (apiKey: string) => listText(xai(apiKey), XAI_TEXT)

/**
 * Neither API says which models take an effort: send it, and retry once without it on a 400 about it — one that names
 * the parameter, or OpenAI's "Unsupported value: 'low' … Supported values are: 'high'" (commit-tools `isUnsupportedEffort`).
 */
function withEffortFallback(
  run: (withEffort: boolean) => Promise<ProviderOutput>,
  names: RegExp
): Future<Error, ProviderOutput> {
  return Future.attemptP(() =>
    run(true).catch((error: unknown) => {
      if (error instanceof OpenAI.BadRequestError && (error.param === "reasoning.effort" || names.test(error.message)))
        return run(false)
      throw error
    })
  )
}

function toUsage(input: number, output: number, total: number): TokenUsage {
  return { input: Just(input), output: Just(output), total: Just(total) }
}

/** An empty answer is a failed call (commit-tools response-parser.ts). */
function output(text: string | null | undefined, tokens: Maybe<TokenUsage>, effortSent: boolean): ProviderOutput {
  const trimmed = (text ?? "").trim()
  if (trimmed === "") throw new Error("Provider returned an empty response")
  return { text: trimmed, tokens, effortSent }
}

// Responses API, as commit-tools infra/llm/openai.ts:40-49, non-streaming.
function generateWithOpenAI(apiKey: string, r: LlmRequest): Future<Error, ProviderOutput> {
  const client = openai(apiKey)
  return withEffortFallback(async (withEffort) => {
    const res = await client.responses.create({
      model: r.model,
      // Omitted rather than `null` when there is none, as the API documents it.
      ...r.systemInstruction.map((instructions): { instructions?: string } => ({ instructions })).withDefault({}),
      input: r.prompt,
      store: false,
      max_output_tokens: r.maxOutputTokens,
      ...(withEffort ? { reasoning: { effort: r.effort } } : {}),
    })
    return output(
      res.output_text,
      fromOptional(res.usage).map((u) => toUsage(u.input_tokens, u.output_tokens, u.total_tokens)),
      withEffort
    )
  }, /reasoning|supported values are/i)
}

// Chat Completions + reasoning_effort, as commit-tools infra/llm/xai.ts:23-47.
function generateWithXai(apiKey: string, r: LlmRequest): Future<Error, ProviderOutput> {
  const client = xai(apiKey)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = r.systemInstruction
    .map((system): OpenAI.Chat.ChatCompletionMessageParam[] => [
      { role: "system", content: system },
      { role: "user", content: r.prompt },
    ])
    .withDefault([{ role: "user", content: r.prompt }])
  return withEffortFallback(async (withEffort) => {
    const completion = await client.chat.completions.create({
      model: r.model,
      messages,
      max_completion_tokens: r.maxOutputTokens,
      ...(withEffort ? { reasoning_effort: r.effort } : {}),
    })
    return output(
      completion.choices[0]?.message?.content,
      fromOptional(completion.usage).map((u) => toUsage(u.prompt_tokens, u.completion_tokens, u.total_tokens)),
      withEffort
    )
  }, /reasoning_effort/i)
}
