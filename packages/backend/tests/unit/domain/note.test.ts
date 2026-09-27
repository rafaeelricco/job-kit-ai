import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Future } from "@lib/future"
import { Failure } from "@lib/result"
import * as s from "@lib/json/schema"
import { POSIX } from "@lib/time"
import { MemoryEventDatabase } from "@tests/support/memory"
import { controller as create } from "@be/domain/note/command/createNote"
import { controller as update } from "@be/domain/note/command/updateNote"
import { controller as remove } from "@be/domain/note/command/deleteNote"
import { controller as get } from "@be/domain/note/query/getNote"
import { RepoNotes, type NoteDocument } from "@be/domain/note/projection/notes"
import { Note } from "@be/domain/note/aggregate/note"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { NoteDeleted } from "@be/domain/note/events/note/noteDeleted"
import { schemas } from "@be/app/events"
import { type ReadProjections } from "@be/app/projections"
import { type ProjectionReader } from "@be/app/projectionStore"
import { Id } from "@be/lib/event-sourcing/event"
import { result, rejection, newNote, hydrate, info, projectionsHarness, delivery } from "@tests/support/notes"
import { asUser, asUserCommand } from "@tests/support/auth"

// Compile-time pin, checked by `pnpm typecheck`: a query's view of the read
// model has no way to write. If `save` ever becomes reachable from
// `ReadProjections`, the directive below stops compiling.
export const queriesCannotWrite = (projections: ReadProjections, doc: NoteDocument): unknown =>
  // @ts-expect-error -- `NotesReader` has no `save`.
  projections[RepoNotes.collectionName].save(doc)

describe("Notes", () => {
  test("create trims only title and preserves body including whitespace", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db, "  shopping  ", "  milk\n")
    assert.equal(db.entries.length, 1)
    assert.equal(db.entries[0]?.event_name, "NoteCreated")
    const note = hydrate(db)
    assert.equal(note.values.aggregateId.value, noteId.value)
    assert.equal(note.values.aggregateVersion, 0)
    assert.equal(note.values.title, "shopping")
    assert.equal(note.values.body, "  milk\n")
    assert.equal(note.values.status === "Deleted", false)
    assert.equal(note.values.createdAt.value, db.entries[0]?.recorded_on.value)
    assert.equal(note.values.updatedAt.value, note.values.createdAt.value)
  })

  test("empty body is a valid note", async () => {
    const db = new MemoryEventDatabase()
    await newNote(db, "Empty", "")
    assert.equal(hydrate(db).values.body, "")
  })

  test("blank title fails before opening the event store", async () => {
    const db = new MemoryEventDatabase()
    const error = await rejection(
      create.handler({
        payload: { noteId: Id.random<"Note">(), title: " \n ", body: "" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    assert.match(JSON.stringify(error), /400/)
    assert.equal(db.entries.length, 0)
  })

  test("update replaces both values and replay preserves timestamps and versions", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    await result(
      update.handler({
        payload: { noteId, title: " Updated ", body: "" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    const note = hydrate(db)
    assert.equal(note.values.title, "Updated")
    assert.equal(note.values.body, "")
    assert.equal(note.values.aggregateVersion, 1)
    assert.equal(note.values.createdAt.value, db.entries[0]?.recorded_on.value)
    assert.equal(note.values.updatedAt.value, db.entries[1]?.recorded_on.value)
    const again = hydrate(db)
    assert.deepEqual(again.values, note.values)
  })

  test("identical update emits no redundant event", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    await result(
      update.handler({
        payload: { noteId, title: " My note ", body: "text" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    assert.equal(db.entries.length, 1)
  })

  test("blank update is rejected without an event", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    const error = await rejection(
      update.handler({
        payload: { noteId, title: " ", body: "changed" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    assert.match(JSON.stringify(error), /400/)
    assert.equal(db.entries.length, 1)
  })

  test("delete tombstones the aggregate and repeat deletion is a no-op", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    await result(
      remove.handler({
        payload: { noteId },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    await result(
      remove.handler({
        payload: { noteId },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    assert.deepEqual(
      db.entries.map((e) => e.event_name),
      ["NoteCreated", "NoteDeleted"]
    )
    assert.equal(hydrate(db).values.status === "Deleted", true)
    assert.equal(hydrate(db).values.aggregateVersion, 1)
  })

  test("missing and deleted notes cannot be updated", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    await result(
      remove.handler({
        payload: { noteId },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    for (const id of [noteId, new Id<"Note">("missing")]) {
      const error = await rejection(
        update.handler({
          payload: { noteId: id, title: "New", body: "new" },
          withEventStore: db.withEventStore,
          ...asUserCommand(),
        })
      )
      assert.match(JSON.stringify(error), /404/)
    }
    assert.equal(db.entries.length, 2)
  })

  test("deleting an unknown note returns 404", async () => {
    const db = new MemoryEventDatabase()
    const error = await rejection(
      remove.handler({
        payload: { noteId: new Id("unknown") },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    assert.match(JSON.stringify(error), /404/)
    assert.equal(db.entries.length, 0)
  })

  test("creation/update/deletion events round-trip through registered schemas", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    await result(
      update.handler({
        payload: { noteId, title: "Second", body: "new" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    await result(
      remove.handler({
        payload: { noteId },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    assert.deepEqual(
      db.entries.map((entry) => entry.aggregate_version),
      [0, 1, 2]
    )
    assert.equal(hydrate(db).values.title, "Second")
    assert.equal(hydrate(db).values.status === "Deleted", true)
    assert.equal(hydrate(db).values.updatedAt.value, db.entries[2]?.recorded_on.value)
  })

  test("transformation events default causation to themselves and honor caller ids", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    await result(
      update.handler({
        payload: { noteId, title: "Second", body: "new" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    const trigger = new Id<"Event">("trigger")
    await db
      .withEventStore(
        (e) => e,
        function* (store) {
          yield* store.emit({
            aggregate: Note,
            event: new NoteDeleted({
              type: NoteDeleted.type,
              aggregateId: noteId,
            }),
            correlation_id: trigger,
            causation_id: trigger,
          })
        }
      )
      .promise((e) => e)
    const [created, updated, deleted] = db.entries
    assert.equal(updated?.correlation_id.value, created?.correlation_id.value)
    assert.equal(updated?.causation_id.value, updated?.event_id.value)
    assert.equal(deleted?.correlation_id.value, trigger.value)
    assert.equal(deleted?.causation_id.value, trigger.value)
  })

  test("events record schema version 1 and an unknown version fails hydration", async () => {
    const db = new MemoryEventDatabase()
    await newNote(db)
    assert.equal(db.entries[0]?.schema_version, 1)
    const future = db.entries.map((e) => ({ ...e, schema_version: 2 }))
    assert.equal(schemas.hydrate(Note, future) instanceof Failure, true)
  })

  test("get-note returns only public fields and unknown notes return 404", async () => {
    const h = projectionsHarness()
    const noteId = new Id<"Note">("visible")
    await delivery(
      h,
      new NoteCreated({
        type: NoteCreated.type,
        aggregateId: noteId,
        title: "Hello",
        body: "",
      }),
      info(noteId, 0)
    ).promise((e) => new Error(JSON.stringify(e)))
    const response = await result(get.handler({ payload: { noteId }, projections: h.projections, ...asUser }))
    const encoded = s.encode(get.endpoint.response, response)
    assert.deepEqual(Object.keys(encoded as object).sort(), ["note"])
    assert.equal(JSON.stringify(encoded).includes("deleted"), false)
    const error = await rejection(
      get.handler({
        payload: { noteId: new Id("missing") },
        projections: h.projections,
        ...asUser,
      })
    )
    assert.match(JSON.stringify(error), /404/)
  })

  test("repository filters tombstones and sorts by timestamp then note ID", async () => {
    const document = (id: string, time: number, deleted = false): NoteDocument => ({
      noteId: new Id(id),
      title: id,
      body: "",
      createdAt: new POSIX(0),
      updatedAt: new POSIX(time),
      status: deleted ? "Deleted" : "Active",
    })
    const rows = [document("b", 2000), document("old", 1000), document("hidden", 3000, true), document("a", 2000)]
    const store = { find: () => Future.resolve(rows) } as unknown as ProjectionReader
    const repo = RepoNotes.reader({ values: RepoNotes }, store)
    assert.deepEqual(
      (await repo.findActive().promise((e) => new Error(JSON.stringify(e)))).map((note) => note.noteId.value),
      ["a", "b", "old"]
    )
  })

  test("get-note reports storage failures as 500", async () => {
    const h = projectionsHarness()
    const unavailable: ReadProjections = {
      [RepoNotes.collectionName]: {
        ...h.projections[RepoNotes.collectionName],
        getById: () =>
          Future.reject({
            type: "driver",
            error: new Error("Database unavailable"),
          }),
      },
    }
    const error = await rejection(
      get.handler({
        payload: { noteId: new Id("any") },
        projections: unavailable,
        ...asUser,
      })
    )
    assert.match(JSON.stringify(error), /500/)
  })
})
