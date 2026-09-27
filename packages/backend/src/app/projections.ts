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
import {
  RepoAiSetups,
  type AiSetupDocument,
  type AiSetupsReader,
  type AiSetupsWriter,
} from "@be/domain/ai/projection/aiSetups"

export type Repositories = {
  [RepoAiSetups.collectionName]: Repository<AiSetupDocument>
  [RepoProjectionIdempotency.collectionName]: Repository<ProjectedEvent>
}

export function initializeRepositories(db: Db): Future<ProjectionStoreError, Repositories> {
  return createRepository(db, RepoAiSetups).chain((aiSetups) =>
    createRepository(db, RepoProjectionIdempotency).map((idempotency) => ({
      [RepoAiSetups.collectionName]: aiSetups,
      [RepoProjectionIdempotency.collectionName]: idempotency,
    }))
  )
}

/** The read model as a query sees it. No idempotency log, no way to write. */
export type ReadProjections = {
  readonly [RepoAiSetups.collectionName]: AiSetupsReader
}

/** The read model as a projection sees it. Assignable to `ReadProjections`. */
export type WriteProjections = {
  readonly [RepoAiSetups.collectionName]: AiSetupsWriter
  readonly [RepoProjectionIdempotency.collectionName]: IdempotencyRepo
}

export function readProjections(repositories: Repositories, store: ProjectionReader): ReadProjections {
  return {
    [RepoAiSetups.collectionName]: RepoAiSetups.reader(repositories[RepoAiSetups.collectionName], store),
  }
}

export function writeProjections(repositories: Repositories, store: ProjectionWriter): WriteProjections {
  return {
    [RepoAiSetups.collectionName]: RepoAiSetups.writer(repositories[RepoAiSetups.collectionName], store),
    [RepoProjectionIdempotency.collectionName]: RepoProjectionIdempotency.writer(
      repositories[RepoProjectionIdempotency.collectionName],
      store
    ),
  }
}
