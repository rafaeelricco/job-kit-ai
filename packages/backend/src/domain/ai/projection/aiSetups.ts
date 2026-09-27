export { controller, RepoAiSetups, type AiSetupDocument, type AiSetupsReader, type AiSetupsWriter }

import * as d from "@lib/json/decoder"
import * as m from "@lib/maybe"
import * as s from "@lib/json/schema"

import { Future } from "@lib/future"
import { type Maybe } from "@lib/maybe"
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
import { schema_AiState, initialAi, applyAiEvent, type AiState } from "@be/domain/workspace/aggregate/aiState"
import { WorkspaceProvisioned } from "@be/domain/workspace/events/workspace/workspaceProvisioned"
import { SetupStepCompleted } from "@be/domain/workspace/events/workspace/setupStepCompleted"
import { AiAuthorizationStarted } from "@be/domain/workspace/events/workspace/aiAuthorizationStarted"
import { AiConnectionVerified } from "@be/domain/workspace/events/workspace/aiConnectionVerified"
import { AiConnectionReconnected } from "@be/domain/workspace/events/workspace/aiConnectionReconnected"
import { AiConnectionChecked } from "@be/domain/workspace/events/workspace/aiConnectionChecked"
import { AiSwitchConfirmed } from "@be/domain/workspace/events/workspace/aiSwitchConfirmed"
import { AiSwitchDiscarded } from "@be/domain/workspace/events/workspace/aiSwitchDiscarded"
import { AiConnectionDisconnected } from "@be/domain/workspace/events/workspace/aiConnectionDisconnected"
import { AiPreferencesChanged } from "@be/domain/workspace/events/workspace/aiPreferencesChanged"

/**
 * The AI setup read model: one document per workspace holding setup
 * progress and the connection registry. Refs and metadata only — the
 * shared `AiState` shape never carries a secret, so neither does this.
 */
type AiSetupDocument = { workspaceId: Id<"Workspace">; ai: AiState }

const schema_AiSetupDocument: s.Schema<AiSetupDocument> = s.object({
  workspaceId: Id.schema<"Workspace">(),
  ai: schema_AiState,
})

/** What queries get: look a workspace's AI setup up, never change it. */
type AiSetupsReader = {
  readonly get: (workspaceId: Id<"Workspace">) => Future<ProjectionStoreError, Maybe<AiSetupDocument>>
}

/** What the projection gets: a reader that can also save. */
type AiSetupsWriter = AiSetupsReader & {
  readonly save: (doc: AiSetupDocument) => Future<ProjectionStoreError, void>
}

function aiSetupsReader(repo: Repository<AiSetupDocument>, store: ProjectionReader): AiSetupsReader {
  return {
    get: (workspaceId) => store.findOne(repo, { _id: workspaceId.value }),
  }
}

function aiSetupsWriter(repo: Repository<AiSetupDocument>, store: ProjectionWriter): AiSetupsWriter {
  return {
    ...aiSetupsReader(repo, store),
    save: (doc) => store.upsert(repo, doc),
  }
}

/**
 * The AI setup read model: collection metadata plus the two ways to open it.
 *
 * ```ts
 * RepoAiSetups.reader(repo, store).get(workspaceId)     // in a query
 * RepoAiSetups.writer(repo, store).save(document)       // in the projection
 * ```
 */
const RepoAiSetups = {
  collectionName: "Workspace_AiSetups",
  schema: schema_AiSetupDocument,
  createIndexes: async (collection: Collection<JsonDoc>): Promise<void> => {
    await collection.createIndex([["workspaceId", 1]], {
      background: true,
      unique: true,
      name: "WorkspaceId_unique",
    })
  },
  toId: (doc: AiSetupDocument): string => doc.workspaceId.value,

  reader: aiSetupsReader,
  writer: aiSetupsWriter,
} as const

/** Recognizes and decodes this projection's ten workspace/AI events; any other event decodes to `Nothing`. */
const decoder = accept([
  WorkspaceProvisioned,
  SetupStepCompleted,
  AiAuthorizationStarted,
  AiConnectionVerified,
  AiConnectionReconnected,
  AiConnectionChecked,
  AiSwitchConfirmed,
  AiSwitchDiscarded,
  AiConnectionDisconnected,
  AiPreferencesChanged,
])
type Events = m.Infer<d.Infer<typeof decoder>>

function notYetProjected(workspaceId: Id<"Workspace">): string {
  return `Workspace AI setup ${workspaceId.value} not yet projected; will retry`
}

function save(repo: AiSetupsWriter, doc: AiSetupDocument): Future<string, void> {
  return repo.save(doc).mapRej(describeProjectionStoreError)
}

/**
 * Load a workspace's AI setup document, compute its successor with the pure
 * `next`, save it. Rejects with a retry message when the document is not
 * there yet: an AI event can arrive before the `WorkspaceProvisioned` that
 * should have created its document has finished projecting.
 */
function amend(
  repo: AiSetupsWriter,
  workspaceId: Id<"Workspace">,
  next: (existing: AiSetupDocument) => AiSetupDocument
): Future<string, void> {
  return repo
    .get(workspaceId)
    .mapRej(describeProjectionStoreError)
    .chain((found) =>
      found.maybe(Future.reject(notYetProjected(workspaceId)), (existing) => save(repo, next(existing)))
    )
}

function apply(repo: AiSetupsWriter, event: Events, info: EventInfo): Future<string, void> {
  return event instanceof WorkspaceProvisioned
    ? save(repo, { workspaceId: event.values.aggregateId, ai: initialAi })
    : amend(repo, event.values.aggregateId, (existing) => ({
        ...existing,
        ai: applyAiEvent(existing.ai, event.values, info.recorded_on),
      }))
}

const handler: ProjectionHandler<Events> = ({ event, info, projections }): Future<AmbarResponse, void> =>
  apply(projections[RepoAiSetups.collectionName], event, info).mapRej((message) => new ErrorMustRetry(message))

const controller: ProjectionController<Events> = { decoder, handler }
