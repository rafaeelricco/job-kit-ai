import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Nothing } from "@lib/maybe"
import { MemoryEventDatabase } from "@tests/support/memory"
import { Note } from "@be/domain/note/aggregate/note"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { EventStoreCorruptionError, type DatabaseEntry } from "@be/lib/event-sourcing/store"
import { type Aggregate, Id, type IdOf } from "@be/lib/event-sourcing/event"
import { rejection, newNote } from "@tests/support/notes"

describe("event-store read and write errors", () => {
  test("try_find returns Nothing and find reports an unknown aggregate", async () => {
    const db = new MemoryEventDatabase()
    const aggregateId = new Id<"Note">("missing-note")
    const absent = await db
      .withEventStore(
        (error) => error,
        function* (store) {
          return yield* store.try_find(Note, aggregateId)
        }
      )
      .promise((error) => error)
    assert.ok(absent instanceof Nothing)

    const error = await rejection(
      db.withEventStore(
        (value) => value,
        function* (store) {
          return yield* store.find(Note, aggregateId)
        }
      )
    )
    assert.match(error.message, /Unknown aggregate ID missing-note/)
  })

  test("invalid stored history is surfaced as EventStoreCorruptionError", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    const first = db.entries[0]
    assert.ok(first)
    db.entries[0] = { ...first, schema_version: 99 }

    const error = await rejection(
      db.withEventStore(
        (value) => value,
        function* (store) {
          return yield* store.try_find(Note, noteId)
        }
      )
    )
    assert.ok(error instanceof EventStoreCorruptionError)
    assert.match(error.message, /Unsupported schema version 99 for NoteCreated/)
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
          return yield* store.try_find(Note, new Id<"Note">("read-failure"))
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
    const aggregateId = new Id<"Note">("insert-failure")

    const error = await rejection(
      db.withEventStore(
        (value) => value,
        function* (store) {
          return yield* store.emit({
            aggregate: Note,
            event: new NoteCreated({
              type: NoteCreated.type,
              aggregateId,
              title: "Note",
              body: "",
            }),
          })
        }
      )
    )
    assert.equal(error.message, "event insert failed")
    assert.equal(db.entries.length, 0)
  })
})
