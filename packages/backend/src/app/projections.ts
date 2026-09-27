import { Db } from "mongodb"
import { Future } from "@lib/future"
import { RepoProjectionIdempotency, type ProjectedEvent, type IdempotencyRepo } from "@be/app/idempotency"
import {
  createRepository,
  type Repository,
  type ProjectionReader,
  type ProjectionWriter,
  type ProjectionStoreError,
} from "@be/app/projectionStore"
import { RepoNotes, type NoteDocument, type NotesReader, type NotesWriter } from "@be/domain/note/projection/notes"

export type Repositories = {
  [RepoNotes.collectionName]: Repository<NoteDocument>
  [RepoProjectionIdempotency.collectionName]: Repository<ProjectedEvent>
}

export function initializeRepositories(db: Db): Future<ProjectionStoreError, Repositories> {
  return createRepository(db, RepoNotes).chain((notes) =>
    createRepository(db, RepoProjectionIdempotency).map((idempotency) => ({
      [RepoNotes.collectionName]: notes,
      [RepoProjectionIdempotency.collectionName]: idempotency,
    }))
  )
}

/** The read model as a query sees it. No idempotency log, no way to write. */
export type ReadProjections = {
  readonly [RepoNotes.collectionName]: NotesReader
}

/** The read model as a projection sees it. Assignable to `ReadProjections`. */
export type WriteProjections = {
  readonly [RepoNotes.collectionName]: NotesWriter
  readonly [RepoProjectionIdempotency.collectionName]: IdempotencyRepo
}

export function readProjections(repositories: Repositories, store: ProjectionReader): ReadProjections {
  return { [RepoNotes.collectionName]: RepoNotes.reader(repositories[RepoNotes.collectionName], store) }
}

export function writeProjections(repositories: Repositories, store: ProjectionWriter): WriteProjections {
  return {
    [RepoNotes.collectionName]: RepoNotes.writer(repositories[RepoNotes.collectionName], store),
    [RepoProjectionIdempotency.collectionName]: RepoProjectionIdempotency.writer(
      repositories[RepoProjectionIdempotency.collectionName],
      store
    ),
  }
}
