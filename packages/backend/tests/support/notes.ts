import { Future } from "@lib/future"
import { fromNullable } from "@lib/maybe"
import { type Response } from "@be/lib/router"
import { POSIX } from "@lib/time"
import { MemoryEventDatabase } from "@tests/support/memory"
import { asUserCommand } from "@tests/support/auth"
import { Note } from "@be/domain/note/aggregate/note"
import { controller as create } from "@be/domain/note/command/createNote"
import { controller as project, RepoNotes, type NoteDocument, type NotesWriter } from "@be/domain/note/projection/notes"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { NoteUpdated } from "@be/domain/note/events/note/noteUpdated"
import { NoteDeleted } from "@be/domain/note/events/note/noteDeleted"
import { schemas } from "@be/app/events"
import { type WriteProjections } from "@be/app/projections"
import { RepoProjectionIdempotency, type ProjectedEvent, type IdempotencyRepo } from "@be/app/idempotency"
import { withIdempotency } from "@be/app/handleProjection"
import { Id, type EventInfo } from "@be/lib/event-sourcing/event"

async function result<T>(future: Future<Response, T>): Promise<T> {
  return future.promise((error) => new Error(JSON.stringify(error)))
}

async function rejection<E, T>(future: Future<E, T>): Promise<E> {
  return new Promise((resolve, reject) => {
    future.fork(resolve, () => reject(new Error("Expected rejection")))
  })
}

async function newNote(
  db: MemoryEventDatabase,
  title = "My note",
  body = "text",
  noteId = Id.random<"Note">()
): Promise<Id<"Note">> {
  return (
    await result(
      create.handler({
        payload: { noteId, title, body },
        withEventStore: db.withEventStore,
        ...asUserCommand(),
      })
    )
  ).noteId
}

function hydrate(db: MemoryEventDatabase): Note {
  return schemas.hydrate(Note, db.entries).unwrap((message) => message).aggregate
}

function info(noteId: Id<"Note">, version: number): EventInfo {
  return {
    event_id: new Id(`event-${noteId.value}-${version}`),
    aggregate_id: noteId,
    aggregate_version: version,
    correlation_id: new Id(`event-${noteId.value}-0`),
    causation_id: new Id(`event-${noteId.value}-0`),
    recorded_on: new POSIX(1000 + version * 1000),
  }
}

function projectionsHarness(): {
  projections: WriteProjections
  docs: Map<string, NoteDocument>
  seen: Set<string>
} {
  const docs = new Map<string, NoteDocument>()
  const seen = new Set<string>()
  const notes: NotesWriter = {
    // The side effect must happen only when the Future is forked (mirroring
    // the real Mongo-backed `save`, which defers via `Future.attemptP`) —
    // not eagerly when this function is called to build the Future.
    save: (doc) =>
      Future.create((_, resolve) => {
        docs.set(doc.noteId.value, doc)
        resolve(undefined)
      }),
    getById: (id) => Future.resolve(fromNullable(docs.get(id.value) ?? null)),
    findActive: () =>
      Future.resolve(
        [...docs.values()]
          .filter((doc) => doc.status === "Active")
          .sort((a, b) => b.updatedAt.value - a.updatedAt.value || a.noteId.value.localeCompare(b.noteId.value))
      ),
  }
  const key = (v: ProjectedEvent): string => `${v.eventId.value}/${v.projection}`
  const idempotency: IdempotencyRepo = {
    exists: (v) => Future.resolve(seen.has(key(v))),
    // Same laziness requirement as `notes.save` above.
    save: (v) =>
      Future.create((_, resolve) => {
        seen.add(key(v))
        resolve(undefined)
      }),
  }
  return {
    docs,
    seen,
    projections: {
      [RepoNotes.collectionName]: notes,
      [RepoProjectionIdempotency.collectionName]: idempotency,
    },
  }
}

function delivery(
  h: ReturnType<typeof projectionsHarness>,
  event: NoteCreated | NoteUpdated | NoteDeleted,
  metadata: EventInfo
) {
  return withIdempotency(
    h.projections,
    { eventId: metadata.event_id, projection: "/api/v1/note/projection/notes" },
    project.handler({
      event,
      info: metadata,
      projections: h.projections,
    })
  )
}

export { result, rejection, newNote, hydrate, info, projectionsHarness, delivery }
