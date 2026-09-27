import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Future } from "@lib/future"
import { Id } from "@be/lib/event-sourcing/event"
import { RepoProjectionIdempotency, type ProjectedEvent } from "@be/app/idempotency"
import { type Collection, type JsonDoc, type ProjectionWriter, type Repository } from "@be/app/projectionStore"

describe("idempotency repository", () => {
  test("creates the unique delivery index and generated document ids", async () => {
    let index: unknown
    let options: unknown
    const collection = {
      createIndex: async (keys: unknown, value: unknown) => {
        index = keys
        options = value
        return "EventId_ProjectionName_unique"
      },
    } as unknown as Collection<JsonDoc>

    await RepoProjectionIdempotency.createIndexes(collection)
    assert.deepEqual(index, [
      ["eventId", 1],
      ["projection", 1],
    ])
    assert.deepEqual(options, {
      background: true,
      unique: true,
      name: "EventId_ProjectionName_unique",
    })

    const projected = { eventId: new Id<"Event">("event-1"), projection: "/notes" }
    assert.ok(RepoProjectionIdempotency.toId(projected).length > 0)
  })

  test("uses event and projection as the lookup key and inserts the delivery marker", async () => {
    const repository = { values: RepoProjectionIdempotency } as Repository<ProjectedEvent>
    const projected = { eventId: new Id<"Event">("event-2"), projection: "/notes" }
    const calls: Array<{ operation: string; value: unknown }> = []
    const store = {
      find: (_repo: unknown, filter: unknown, options: unknown) => {
        calls.push({ operation: "find", value: { filter, options } })
        return Future.resolve([{ _id: "marker-1" }])
      },
      insert: (_repo: unknown, value: unknown) => {
        calls.push({ operation: "insert", value })
        return Future.resolve(undefined)
      },
    } as unknown as ProjectionWriter
    const writer = RepoProjectionIdempotency.writer(repository, store)

    const exists = await writer.exists(projected).promise((error) => new Error(JSON.stringify(error)))
    await writer.save(projected).promise((error) => new Error(JSON.stringify(error)))

    assert.equal(exists, true)
    assert.deepEqual(calls, [
      {
        operation: "find",
        value: { filter: { eventId: "event-2", projection: "/notes" }, options: { limit: 1 } },
      },
      { operation: "insert", value: projected },
    ])
  })
})
