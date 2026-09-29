export { ENTRY_EXPIRY, failed, probeModels, verifyFailure }

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { Duration } from "@lib/time"
import { type Route, type Provider, EFFORTS, PROVIDER_EFFORTS } from "@be/domain/ai/routes"
import { type Model } from "@be/domain/ai/capabilities"
import { type ReadinessFailure, type Readiness } from "@be/domain/ai/adapter"
import { type Llm, type LlmCredential, type ModelListing } from "@be/app/ai/llm/types"
import { classifyLlmError } from "@be/app/ai/llm/retry"

/** How long a pasted-credential form stays open. */
const ENTRY_EXPIRY = Duration.minutes(10)
const VERIFY_PROMPT = "Reply with the single word OK."
const VERIFY_MAX_TOKENS = 4096

const failed = (reason: ReadinessFailure): Readiness => ({ kind: "failed", reason })

/** A verify that threw: logs the error class only, never its message, and reads as the classified failure. */
const verifyFailure =
  (route: Route) =>
  (error: Error): Future<Error, Readiness> => {
    console.error(`AI verify failed for ${route.provider}/${route.method}: ${error.constructor.name}`)
    return Future.resolve<Error, Readiness>(failed(classifyLlmError(error)))
  }

function probeModels(llm: Llm, provider: Provider, credential: LlmCredential): Future<Error, Maybe<Model[]>> {
  return llm
    .listModels(provider, credential)
    .map((listings) => toModels(provider, listings))
    .chain((models) => {
      const target = models.find((m) => m.recommended)
      if (target === undefined) return Future.resolve<Error, Maybe<Model[]>>(Nothing())
      return llm
        .generate(provider, credential, {
          model: target.id,
          effort: target.efforts[0] ?? "low",
          prompt: VERIFY_PROMPT,
          systemInstruction: Nothing(),
          maxOutputTokens: VERIFY_MAX_TOKENS,
        })
        .map(() => Just(models))
    })
}

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

function toModels(provider: Provider, listings: ModelListing[]): Model[] {
  const sorted = [...listings].sort((a, b) => b.createdAt.value - a.createdAt.value)
  const recommended = sorted.find(isUsable)
  return sorted.map((l) => ({
    id: l.id,
    summary: l.name === l.id ? "" : l.name,
    recommended: l === recommended,
    efforts: l.efforts.withDefault([...PROVIDER_EFFORTS[provider]]),
    usable: isUsable(l),
    reason: unusableReason(l),
  }))
}
