import { expect, test } from "vitest"
import { controller as update } from "@be/domain/note/command/updateNote"
import { controller as remove } from "@be/domain/note/command/deleteNote"
import { controller as create } from "@be/domain/note/command/createNote"
import { controller as list } from "@be/domain/note/query/listNotes"
import { RepoNotes } from "@be/domain/note/projection/notes"
import { MemoryEventDatabase } from "@tests/support/memory"
import { newNote, result, rejection, hydrate, projectionsHarness } from "@tests/support/notes"
import { asUser, asUserCommand } from "@tests/support/auth"
import { Id } from "@be/lib/event-sourcing/event"
import { Future } from "@lib/future"
import { type ReadProjections } from "@be/app/projections"

// Surviving equality mutants showed that changing both fields did not protect
// against accidentally treating a change to just one field as a no-op.
test.each([
  { title: "Changed", body: "Original body" },
  { title: "Original title", body: "Changed" },
])("a change to only one content field emits an update: %j", async ({ title, body }) => {
  const db = new MemoryEventDatabase()
  const noteId = await newNote(db, "Original title", "Original body")
  expect(
    await result(
      update.handler({ payload: { noteId, title, body }, withEventStore: db.withEventStore, ...asUserCommand() })
    )
  ).toEqual({ success: true })
  expect(db.entries.map((entry) => entry.event_name)).toEqual(["NoteCreated", "NoteUpdated"])
  expect(hydrate(db).values).toMatchObject({ title, body, aggregateVersion: 1 })
})

test("successful and repeated update/delete commands return their public acknowledgement", async () => {
  const db = new MemoryEventDatabase()
  const noteId = await newNote(db, "Title", "Body")
  expect(
    await result(
      update.handler({
        payload: { noteId, title: "Title", body: "Body" },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
  ).toEqual({ success: true })
  expect(
    await result(remove.handler({ payload: { noteId }, withEventStore: db.withEventStore, ...asUserCommand() }))
  ).toEqual({
    success: true,
  })
  expect(
    await result(remove.handler({ payload: { noteId }, withEventStore: db.withEventStore, ...asUserCommand() }))
  ).toEqual({
    success: true,
  })
  expect(db.entries.map((entry) => entry.event_name)).toEqual(["NoteCreated", "NoteDeleted"])
})

test("validation and missing-note failures preserve the public error body", async () => {
  const db = new MemoryEventDatabase()
  const noteId = new Id<"Note">("missing")
  const blank = await rejection(
    create.handler({ payload: { noteId, title: " ", body: "" }, withEventStore: db.withEventStore, ...asUserCommand() })
  )
  expect(blank).toMatchObject({ values: { status: 400, content: { error: { message: "Title cannot be empty" } } } })
  const missing = await rejection(
    remove.handler({ payload: { noteId }, withEventStore: db.withEventStore, ...asUserCommand() })
  )
  expect(missing).toMatchObject({ values: { status: 404, content: { error: { message: "Note not found" } } } })
  expect(db.entries).toHaveLength(0)
})

test("list queries hide storage failure details behind a 500 response", async () => {
  const h = projectionsHarness()
  const projections: ReadProjections = {
    ...h.projections,
    [RepoNotes.collectionName]: {
      ...h.projections[RepoNotes.collectionName],
      findActive: () => Future.reject({ type: "driver" as const, error: new Error("private database details") }),
    },
  }
  const error = await rejection(list.handler({ payload: {}, projections, ...asUser }))
  expect(error).toMatchObject({ values: { status: 500 } })
  expect(JSON.stringify(error)).not.toContain("private database details")
})
