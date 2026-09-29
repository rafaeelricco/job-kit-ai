export { listAnthropicModels, generateWithAnthropic }

import * as d from "@lib/json/decoder"

import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX } from "@lib/time"
import { PROVIDER_EFFORTS } from "@be/domain/ai/routes"
import {
  type LlmRequest,
  type ProviderOutput,
  type ModelListing,
  type TokenUsage,
  LLM_TIMEOUT_MS,
} from "@be/app/ai/llm/types"

import Anthropic from "@anthropic-ai/sdk"

const client = (apiKey: string): Anthropic => new Anthropic({ apiKey, maxRetries: 0, timeout: LLM_TIMEOUT_MS })

const capabilitiesDecoder = d.object({
  structured_outputs: d.object({ supported: d.boolean }),
  effort: d.object({
    low: d.object({ supported: d.boolean }),
    medium: d.object({ supported: d.boolean }),
    high: d.object({ supported: d.boolean }),
    xhigh: d.optionalNullable(d.object({ supported: d.boolean })),
    max: d.optionalNullable(d.object({ supported: d.boolean })),
  }),
})

function listAnthropicModels(apiKey: string): Future<Error, ModelListing[]> {
  return Future.attemptP(async () => {
    const out: ModelListing[] = []
    for await (const m of client(apiKey).models.list()) {
      const caps = d.decode(m.capabilities, capabilitiesDecoder).either(
        () => Nothing<d.Infer<typeof capabilitiesDecoder>>(),
        (c) => Just(c)
      )
      out.push({
        id: m.id,
        name: m.display_name,
        createdAt: POSIX.fromDate(new Date(m.created_at)),
        structuredOutput: caps.map((c) => c.structured_outputs.supported),
        efforts: caps.map((c) => PROVIDER_EFFORTS.anthropic.filter((e) => c.effort[e]?.supported === true)),
      })
    }
    return out
  })
}

const EFFORT_REJECTED = /effort/i

const cacheable = (text: string): Anthropic.TextBlockParam => ({
  type: "text",
  text,
  cache_control: { type: "ephemeral" },
})

const extractAnthropicText = (content: Anthropic.ContentBlock[]): string =>
  content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")

function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
  return { input: Just(input), output: Just(usage.output_tokens), total: Just(input + usage.output_tokens) }
}

function buildParams(r: LlmRequest, withEffort: boolean): Anthropic.MessageStreamParams {
  const core: Anthropic.MessageStreamParams = {
    model: r.model,
    max_tokens: r.maxOutputTokens,
    messages: [{ role: "user", content: r.prompt }],
    ...(withEffort ? { output_config: { effort: r.effort } } : {}),
  }
  return r.systemInstruction.maybe(core, (text) => ({ ...core, system: [cacheable(text)] }))
}

function generateWithAnthropic(apiKey: string, r: LlmRequest): Future<Error, ProviderOutput> {
  const stream = (withEffort: boolean): Promise<Anthropic.Message> =>
    client(apiKey).messages.stream(buildParams(r, withEffort)).finalMessage()
  return Future.attemptP(() =>
    stream(true)
      .then((message) => ({ message, effortSent: true }))
      .catch((error: unknown) => {
        if (!(error instanceof Anthropic.BadRequestError && EFFORT_REJECTED.test(error.message))) throw error
        return stream(false).then((message) => ({ message, effortSent: false }))
      })
  ).map(({ message, effortSent }) => ({
    text: Just(extractAnthropicText(message.content)),
    tokens: Just(toTokenUsage(message.usage)),
    effortSent,
  }))
}
