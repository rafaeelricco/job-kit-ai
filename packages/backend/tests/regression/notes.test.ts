import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Failure } from "@lib/result"
import { MemoryEventDatabase } from "@tests/support/memory"
import { Note } from "@be/domain/note/aggregate/note"
import { controller as update } from "@be/domain/note/command/updateNote"
import { controller as get } from "@be/domain/note/query/getNote"
import { controller as list } from "@be/domain/note/query/listNotes"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { NoteUpdated } from "@be/domain/note/events/note/noteUpdated"
import { NoteDeleted } from "@be/domain/note/events/note/noteDeleted"
import { schemas } from "@be/app/events"
import { ErrorMustRetry } from "@be/lib/event-delivery"
import { Id } from "@be/lib/event-sourcing/event"
import { result, rejection, newNote, info, projectionsHarness, delivery } from "@tests/support/notes"
import { asUser, asUserCommand } from "@tests/support/auth"

describe("Notes regression cases", () => {
  test("retried create with the same noteId records one event and the same reply", async () => {
    const db = new MemoryEventDatabase()
    const noteId = Id.random<"Note">()
    const first = await newNote(db, "Once", "text", noteId)
    const second = await newNote(db, "Once", "text", noteId)
    assert.equal(first.value, noteId.value)
    assert.equal(second.value, noteId.value)
    assert.equal(db.entries.length, 1)
  })

  test("hydration rejects a history with a version gap", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db)
    await result(
      update.handler({
        payload: { noteId, title: "Second", body: "new" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
    const gapped = db.entries.map((e, i) => (i === 1 ? { ...e, aggregate_version: 2 } : e))
    assert.equal(schemas.hydrate(Note, gapped) instanceof Failure, true)
  })

  test("projection duplicate delivery cannot resurrect a deleted note", async () => {
    const h = projectionsHarness()
    const noteId = new Id<"Note">("duplicate")
    const created = new NoteCreated({
      type: NoteCreated.type,
      aggregateId: noteId,
      title: "Hello",
      body: "",
    })
    const deleted = new NoteDeleted({
      type: NoteDeleted.type,
      aggregateId: noteId,
    })
    await delivery(h, created, info(noteId, 0)).promise((e) => new Error(JSON.stringify(e)))
    await delivery(h, deleted, info(noteId, 1)).promise((e) => new Error(JSON.stringify(e)))
    await delivery(h, created, info(noteId, 0)).promise((e) => new Error(JSON.stringify(e)))
    assert.equal(h.docs.get(noteId.value)?.status === "Deleted", true)
    assert.equal(h.seen.size, 2)
    assert.deepEqual(await result(list.handler({ payload: {}, projections: h.projections, ...asUser })), { notes: [] })
    const error = await rejection(get.handler({ payload: { noteId }, projections: h.projections, ...asUser }))
    assert.match(JSON.stringify(error), /404/)
  })

  test("projection predecessor failure is retryable and is not marked as delivered", async () => {
    const h = projectionsHarness()
    const noteId = new Id<"Note">("delayed")
    const updated = new NoteUpdated({
      type: NoteUpdated.type,
      aggregateId: noteId,
      title: "Later",
      body: "body",
    })
    const error = await rejection(delivery(h, updated, info(noteId, 1)))
    assert.ok(error instanceof ErrorMustRetry)
    assert.equal(h.seen.size, 0)
    await delivery(
      h,
      new NoteCreated({
        type: NoteCreated.type,
        aggregateId: noteId,
        title: "First",
        body: "",
      }),
      info(noteId, 0)
    ).promise((e) => new Error(JSON.stringify(e)))
    await delivery(h, updated, info(noteId, 1)).promise((e) => new Error(JSON.stringify(e)))
    assert.equal(h.docs.get(noteId.value)?.title, "Later")
    assert.equal(h.docs.get(noteId.value)?.updatedAt.value, 2000)
  })

  test("replaying events into empty projections reconstructs the same document", async () => {
    const noteId = new Id<"Note">("replay")
    const events = [
      new NoteCreated({
        type: NoteCreated.type,
        aggregateId: noteId,
        title: "First",
        body: "",
      }),
      new NoteUpdated({
        type: NoteUpdated.type,
        aggregateId: noteId,
        title: "Next",
        body: "Text",
      }),
      new NoteDeleted({ type: NoteDeleted.type, aggregateId: noteId }),
    ]
    const first = projectionsHarness()
    const second = projectionsHarness()
    for (const [version, event] of events.entries()) {
      await delivery(first, event, info(noteId, version)).promise((e) => new Error(JSON.stringify(e)))
      await delivery(second, event, info(noteId, version)).promise((e) => new Error(JSON.stringify(e)))
    }
    assert.deepEqual(second.docs.get(noteId.value), first.docs.get(noteId.value))
    assert.equal(second.docs.get(noteId.value)?.createdAt.value, 1000)
    assert.equal(second.docs.get(noteId.value)?.updatedAt.value, 3000)
  })
})
