import { Future } from "@lib/future"
import { fromNullable } from "@lib/maybe"
import { RepoAiSetups, type AiSetupDocument, type AiSetupsWriter } from "@be/domain/ai/projection/aiSetups"
import { type WriteProjections } from "@be/app/projections"
import { RepoProjectionIdempotency, type ProjectedEvent, type IdempotencyRepo } from "@be/app/idempotency"

/**
 * An in-memory `AiSetupsWriter` over a `Map`, mirroring the real Mongo-backed
 * `save`'s laziness (the side effect happens only when the returned `Future`
 * is forked, not eagerly when this function builds it).
 */
export function memoryAiSetups(): { writer: AiSetupsWriter; docs: Map<string, AiSetupDocument> } {
  const docs = new Map<string, AiSetupDocument>()
  const writer: AiSetupsWriter = {
    get: (workspaceId) => Future.resolve(fromNullable(docs.get(workspaceId.value) ?? null)),
    save: (doc) =>
      Future.create((_, resolve) => {
        docs.set(doc.workspaceId.value, doc)
        resolve(undefined)
      }),
  }
  return { writer, docs }
}

/**
 * The write-side projection state a projection or idempotency test forks
 * over: an in-memory AI setups repo plus an idempotency repo backed by a
 * `seen` set of `${eventId}/${projection}` keys.
 */
export function projectionsHarness(): {
  projections: WriteProjections
  aiSetups: Map<string, AiSetupDocument>
  seen: Set<string>
} {
  const seen = new Set<string>()
  const { writer, docs: aiSetups } = memoryAiSetups()
  const key = (v: ProjectedEvent): string => `${v.eventId.value}/${v.projection}`
  const idempotency: IdempotencyRepo = {
    exists: (v) => Future.resolve(seen.has(key(v))),
    // Same laziness requirement as `memoryAiSetups`'s `save` above.
    save: (v) =>
      Future.create((_, resolve) => {
        seen.add(key(v))
        resolve(undefined)
      }),
  }
  return {
    aiSetups,
    seen,
    projections: {
      [RepoAiSetups.collectionName]: writer,
      [RepoProjectionIdempotency.collectionName]: idempotency,
    },
  }
}
