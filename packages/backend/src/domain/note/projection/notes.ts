export { controller, RepoNotes, type NoteDocument, type NotesReader, type NotesWriter, activeDocument }

import * as d from "@lib/json/decoder"
import * as m from "@lib/maybe"
import * as s from "@lib/json/schema"

import { Future } from "@lib/future"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { POSIX } from "@lib/time"
import {
  type JsonDoc,
  Collection,
  type Repository,
  type ProjectionReader,
  type ProjectionWriter,
  type ProjectionStoreError,
  describeProjectionStoreError,
} from "@be/app/projectionStore"
import { type ProjectionController, type ProjectionHandler } from "@be/app/handleProjection"
import { type AmbarResponse, ErrorMustRetry } from "@be/lib/event-delivery"
import { type EventInfo, Id } from "@be/lib/event-sourcing/event"
import { accept } from "@be/lib/event-sourcing/projection"
import { type NoteStatus } from "@be/domain/note/aggregate/note"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { NoteUpdated } from "@be/domain/note/events/note/noteUpdated"
import { NoteDeleted } from "@be/domain/note/events/note/noteDeleted"

/**
 * Mongo keeps storing `deleted: boolean` on the wire; the schema's outer
 * `dimap` renames it to `status: NoteStatus` for everything above
 * this module, so no application code sees a raw boolean tombstone flag.
 */
type NoteDocument = {
  noteId: Id<"Note">
  title: string
  body: string
  createdAt: POSIX
  updatedAt: POSIX
  status: NoteStatus
}

const schema_NoteDocument: s.Schema<NoteDocument> = s
  .object({
    noteId: Id.schema<"Note">(),
    title: s.string,
    body: s.string,
    createdAt: POSIX.schema,
    updatedAt: POSIX.schema,
    deleted: s.boolean,
  })
  .dimap(
    ({ deleted, ...rest }): NoteDocument => ({
      ...rest,
      status: deleted ? "Deleted" : "Active",
    }),
    ({ status, ...rest }) => ({ ...rest, deleted: status === "Deleted" })
  )

/** What queries get: look notes up, never change them. */
type NotesReader = {
  readonly getById: (noteId: Id<"Note">) => Future<ProjectionStoreError, Maybe<NoteDocument>>
  /** Live notes, newest edit first; the id breaks ties so the order is stable. */
  readonly findActive: () => Future<ProjectionStoreError, NoteDocument[]>
}

/** What the projection gets: a reader that can also save. */
type NotesWriter = NotesReader & {
  readonly save: (doc: NoteDocument) => Future<ProjectionStoreError, void>
}

/** Newest edit first, id as tie-break. Pure, so the ordering is testable without a store. */
function activeNewestFirst(rows: NoteDocument[]): NoteDocument[] {
  return rows
    .filter((note) => note.status === "Active")
    .sort((a, b) => b.updatedAt.value - a.updatedAt.value || a.noteId.value.localeCompare(b.noteId.value))
}

function notesReader(repo: Repository<NoteDocument>, store: ProjectionReader): NotesReader {
  return {
    getById: (noteId) => store.findOne(repo, { _id: noteId.value }),
    findActive: () => store.find(repo, {}).map(activeNewestFirst),
  }
}

function notesWriter(repo: Repository<NoteDocument>, store: ProjectionWriter): NotesWriter {
  return {
    ...notesReader(repo, store),
    save: (doc) => store.upsert(repo, doc),
  }
}

/**
 * The notes read model: collection metadata plus the two ways to open it.
 *
 * ```ts
 * RepoNotes.reader(repo, store).findActive()        // in a query
 * RepoNotes.writer(repo, store).save(document)      // in the projection
 * ```
 */
const RepoNotes = {
  collectionName: "Note_Notes",
  schema: schema_NoteDocument,
  createIndexes: async (_collection: Collection<JsonDoc>): Promise<void> => {},
  toId: (doc: NoteDocument): string => doc.noteId.value,

  reader: notesReader,
  writer: notesWriter,
} as const

/**
 * `Nothing` for a tombstoned document — mirrors `activeNote` on the
 * aggregate, for the read side.
 */
function activeDocument(doc: NoteDocument): Maybe<NoteDocument> {
  return doc.status === "Active" ? Just(doc) : Nothing()
}

/** Recognizes and decodes this projection's three note events; any other event decodes to `Nothing`. */
const decoder = accept([NoteCreated, NoteUpdated, NoteDeleted])
type Events = m.Infer<d.Infer<typeof decoder>>

function notYetProjected(noteId: Id<"Note">): string {
  return `Note ${noteId.value} not yet projected; will retry`
}

function createdDocument(event: NoteCreated, info: EventInfo): NoteDocument {
  return {
    noteId: event.values.aggregateId,
    title: event.values.title,
    body: event.values.body,
    createdAt: info.recorded_on,
    updatedAt: info.recorded_on,
    status: "Active",
  }
}

function updatedDocument(existing: NoteDocument, event: NoteUpdated, info: EventInfo): NoteDocument {
  return {
    ...existing,
    title: event.values.title,
    body: event.values.body,
    updatedAt: info.recorded_on,
  }
}

/** `existing` as a tombstone. The row stays so a late `NoteUpdated` still finds its predecessor. */
function deletedDocument(existing: NoteDocument, info: EventInfo): NoteDocument {
  return {
    ...existing,
    status: "Deleted",
    updatedAt: info.recorded_on,
  }
}

function save(repo: NotesWriter, doc: NoteDocument): Future<string, void> {
  return repo.save(doc).mapRej(describeProjectionStoreError)
}

/**
 * Load a note's document, compute its successor with the pure `next`, save it.
 * Rejects with a retry message when the document is not there yet: an event
 * can arrive before its predecessor has been projected.
 */
function amend(
  repo: NotesWriter,
  noteId: Id<"Note">,
  next: (existing: NoteDocument) => NoteDocument
): Future<string, void> {
  return repo
    .getById(noteId)
    .mapRej(describeProjectionStoreError)
    .chain((found) => found.maybe(Future.reject(notYetProjected(noteId)), (existing) => save(repo, next(existing))))
}

/**
 * Applies one projected event to the notes read model. Returns a rejected
 * `Future<string, void>` (never throws) so `handler` below can fold every
 * failure mode — storage errors and the "predecessor not projected yet"
 * retry case alike — into a single `ErrorMustRetry`.
 */
function apply(repo: NotesWriter, event: Events, info: EventInfo): Future<string, void> {
  switch (true) {
    case event instanceof NoteCreated:
      return save(repo, createdDocument(event, info))
    case event instanceof NoteUpdated:
      return amend(repo, event.values.aggregateId, (existing) => updatedDocument(existing, event, info))
    case event instanceof NoteDeleted:
      return amend(repo, event.values.aggregateId, (existing) => deletedDocument(existing, info))
    default:
      return event satisfies never
  }
}

const handler: ProjectionHandler<Events> = ({ event, info, projections }): Future<AmbarResponse, void> =>
  apply(projections[RepoNotes.collectionName], event, info).mapRej((message) => new ErrorMustRetry(message))

const controller: ProjectionController<Events> = { decoder, handler }
