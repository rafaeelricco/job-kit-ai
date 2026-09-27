export { RepoProjectionIdempotency, type ProjectedEvent, type IdempotencyRepo }

import { Id } from "@be/lib/event-sourcing/event"
import * as s from "@lib/json/schema"
import { Future } from "@lib/future"
import {
  type JsonDoc,
  type Repository,
  Collection,
  type ProjectionWriter,
  type ProjectionStoreError,
} from "@be/app/projectionStore"
import { createId } from "@paralleldrive/cuid2"

/**
 * An event projected from the event store.
 * Might be for a projection or for a reaction endpoint.
 */
type ProjectedEvent = s.Infer<typeof schema_Idempotency>

const schema_Idempotency = s.object({
  eventId: Id.schema<"Event">(),
  projection: s.string,
})

type IdempotencyRepo = {
  readonly exists: (v: ProjectedEvent) => Future<ProjectionStoreError, boolean>
  readonly save: (v: ProjectedEvent) => Future<ProjectionStoreError, void>
}

/** This is used both for projections and for reactions. */
const RepoProjectionIdempotency = {
  collectionName: "Idempotency",
  schema: schema_Idempotency,
  createIndexes: async (collection: Collection<JsonDoc>): Promise<void> => {
    await collection.createIndex(
      [
        ["eventId", 1],
        ["projection", 1],
      ],
      {
        background: true,
        unique: true,
        name: "EventId_ProjectionName_unique",
      }
    )
  },
  toId: (_: ProjectedEvent): string => {
    // the id isn't meaningful because we are deduplicating based on eventId + projection name
    return createId()
  },

  writer: (repo: Repository<ProjectedEvent>, store: ProjectionWriter): IdempotencyRepo => ({
    // Check if an event has already been handled.
    exists: (v) =>
      store
        .find(repo, { eventId: v.eventId.value, projection: v.projection }, { limit: 1 })
        .map((rows) => rows.length > 0),
    // Mark the event as handled
    save: (v) => store.insert(repo, v),
  }),
} as const
