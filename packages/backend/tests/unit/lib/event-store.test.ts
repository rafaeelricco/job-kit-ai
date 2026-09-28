import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Nothing } from "@lib/maybe"
import { MemoryEventDatabase } from "@tests/support/memory"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { WorkspaceProvisioned } from "@be/domain/workspace/events/workspace/workspaceProvisioned"
import { EventStoreCorruptionError, type DatabaseEntry } from "@be/lib/event-sourcing/store"
import { type Aggregate, Id, type IdOf } from "@be/lib/event-sourcing/event"
import { rejection } from "@tests/support/future"

/** Emits one `WorkspaceProvisioned` directly through the event store, building a one-event history. */
async function provisionedWorkspace(db: MemoryEventDatabase): Promise<Id<"Workspace">> {
  const workspaceId = Id.random<"Workspace">()
  await db
    .withEventStore(
      (error) => error,
      function* (store) {
        yield* store.emit({
          aggregate: Workspace,
          event: new WorkspaceProvisioned({
            type: WorkspaceProvisioned.type,
            aggregateId: workspaceId,
            ownerId: Id.random<"User">(),
          }),
        })
      }
    )
    .promise((error) => {
      throw error
    })
  return workspaceId
}

describe("event-store read and write errors", () => {
  test("try_find returns Nothing and find reports an unknown aggregate", async () => {
    const db = new MemoryEventDatabase()
    const aggregateId = new Id<"Workspace">("missing-workspace")
    const absent = await db
      .withEventStore(
        (error) => error,
        function* (store) {
          return yield* store.try_find(Workspace, aggregateId)
        }
      )
      .promise((error) => error)
    assert.ok(absent instanceof Nothing)

    const error = await rejection(
      db.withEventStore(
        (value) => value,
        function* (store) {
          return yield* store.find(Workspace, aggregateId)
        }
      )
    )
    assert.match(error.message, /Unknown aggregate ID missing-workspace/)
  })

  test("invalid stored history is surfaced as EventStoreCorruptionError", async () => {
    const db = new MemoryEventDatabase()
    const workspaceId = await provisionedWorkspace(db)
    const first = db.entries[0]
    assert.ok(first)
    db.entries[0] = { ...first, schema_version: 99 }

    const error = await rejection(
      db.withEventStore(
        (value) => value,
        function* (store) {
          return yield* store.try_find(Workspace, workspaceId)
        }
      )
    )
    assert.ok(error instanceof EventStoreCorruptionError)
    assert.match(error.message, /Unsupported schema version 99 for WorkspaceProvisioned/)
  })

  test("database read errors propagate through the event-store runner", async () => {
    class ReadFailureDatabase extends MemoryEventDatabase {
      override async findAll<T extends Aggregate<string>>(_aggregateId: IdOf<T>): Promise<DatabaseEntry[]> {
        throw new Error("event table unavailable")
      }
    }
    const db = new ReadFailureDatabase()

    const error = await rejection(
      db.withEventStore(
        (value) => value,
        function* (store) {
          return yield* store.try_find(Workspace, new Id<"Workspace">("read-failure"))
        }
      )
    )
    assert.equal(error.message, "event table unavailable")
  })

  test("event insert errors reject the emitted event operation", async () => {
    class InsertFailureDatabase extends MemoryEventDatabase {
      override async insert(_entry: DatabaseEntry): Promise<void> {
        throw new Error("event insert failed")
      }
    }
    const db = new InsertFailureDatabase()
    const aggregateId = new Id<"Workspace">("insert-failure")

    const error = await rejection(
      db.withEventStore(
        (value) => value,
        function* (store) {
          return yield* store.emit({
            aggregate: Workspace,
            event: new WorkspaceProvisioned({
              type: WorkspaceProvisioned.type,
              aggregateId,
              ownerId: Id.random<"User">(),
            }),
          })
        }
      )
    )
    assert.equal(error.message, "event insert failed")
    assert.equal(db.entries.length, 0)
  })
})
