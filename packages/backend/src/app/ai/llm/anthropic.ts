export { listAnthropicModels, generateWithAnthropic }

import Anthropic from "@anthropic-ai/sdk"

import * as d from "@lib/json/decoder"
import { Future } from "@lib/future"
import { Just, Nothing } from "@lib/maybe"
import { POSIX } from "@lib/time"

import { EFFORTS } from "@be/domain/ai/routes"
import { type LlmRequest, type ProviderOutput, type ModelListing } from "@be/app/ai/llm/router"

// plain ms: SDK option
const TIMEOUT_MS = 120_000
const client = (apiKey: string) => new Anthropic({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS })

/** `capabilities` is an untyped tree on the wire (Models API, since Mar 2026): decode only the leaves Job Kit reads. */
const leaf = d.object({ supported: d.boolean })
const capabilitiesDecoder = d.object({
  structured_outputs: leaf,
  effort: d.object({ low: leaf, medium: leaf, high: leaf }),
})

function listAnthropicModels(apiKey: string): Future<Error, ModelListing[]> {
  return Future.attemptP(async () => {
    const out: ModelListing[] = []
    for await (const m of client(apiKey).models.list()) {
      // An older model, or a tree this decoder doesn't know: fall back to "unknown", not a failed verify.
      const caps = d.decode(m.capabilities, capabilitiesDecoder).either(
        () => Nothing<d.Infer<typeof capabilitiesDecoder>>(),
        (c) => Just(c)
      )
      out.push({
        id: m.id,
        name: m.display_name,
        createdAt: POSIX.fromDate(new Date(m.created_at)),
        structuredOutput: caps.map((c) => c.structured_outputs.supported),
        efforts: caps.map((c) => EFFORTS.filter((e) => c.effort[e].supported)),
      })
    }
    return out
  })
}

/** A 400 about `output_config.effort`: a model whose `capabilities` weren't reported, so it was offered every effort. */
const EFFORT_REJECTED = /effort/i

/**
 * No `thinking` param: models that think by default (Opus 5+) keep doing so, and Opus 4.5, which takes an effort but
 * not adaptive thinking, doesn't 400. Efforts come from `capabilities`; a model without them that rejects the effort
 * gets one retry without it, like the OpenAI-compatible calls.
 */
function generateWithAnthropic(apiKey: string, r: LlmRequest): Future<Error, ProviderOutput> {
  const create = (withEffort: boolean) => {
    const base = {
      model: r.model,
      max_tokens: r.maxOutputTokens,
      messages: [{ role: "user" as const, content: r.prompt }],
      ...(withEffort ? { output_config: { effort: r.effort } } : {}),
    }
    return client(apiKey).messages.create(
      r.systemInstruction.unwrap(
        () => base,
        (system) => ({ ...base, system })
      )
    )
  }
  return Future.attemptP(async () => {
    let effortSent = true
    const message = await create(true).catch((error: unknown) => {
      if (!(error instanceof Anthropic.BadRequestError && EFFORT_REJECTED.test(error.message))) throw error
      effortSent = false
      return create(false)
    })
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    // same empty-text rule as openai.ts `output`
    if (text.trim() === "") throw new Error("Provider returned an empty response")
    const input =
      message.usage.input_tokens +
      (message.usage.cache_creation_input_tokens ?? 0) +
      (message.usage.cache_read_input_tokens ?? 0)
    return {
      text,
      tokens: Just({
        input: Just(input),
        output: Just(message.usage.output_tokens),
        total: Just(input + message.usage.output_tokens),
      }),
      effortSent,
    }
  })
}
