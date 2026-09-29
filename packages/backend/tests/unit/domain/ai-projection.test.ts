import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { Just } from "@lib/maybe"
import { POSIX } from "@lib/time"
import { Future } from "@lib/future"
import { Id, type EventInfo } from "@be/lib/event-sourcing/event"
import { ErrorMustRetry } from "@be/lib/event-delivery"
import { withIdempotency } from "@be/app/handleProjection"
import { type ReadProjections } from "@be/app/projections"
import { type JsonDoc, type ProjectionReader, type ProjectionWriter, type Collection } from "@be/app/projectionStore"
import { controller as aiSetupsProjection, RepoAiSetups } from "@be/domain/ai/projection/aiSetups"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { initialAi } from "@be/domain/workspace/aggregate/aiState"
import { toSetupView } from "@be/domain/ai/views"
import { routeViews } from "@be/domain/ai/routes"
import { routeMode } from "@be/app/ai/connections"
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
import { controller as getAiSetup, handler } from "@be/domain/ai/query/getSetup"
import { testUser } from "@tests/support/auth"
import { result, rejection } from "@tests/support/future"
import { projectionsHarness } from "@tests/support/aiSetups"

type AiProjectedEvent =
  | WorkspaceProvisioned
  | SetupStepCompleted
  | AiAuthorizationStarted
  | AiConnectionVerified
  | AiConnectionReconnected
  | AiConnectionChecked
  | AiSwitchConfirmed
  | AiSwitchDiscarded
  | AiConnectionDisconnected
  | AiPreferencesChanged

const PROJECTION_ENDPOINT = "/api/v1/ai/projection/ai-setups"

function info(workspaceId: Id<"Workspace">, version: number): EventInfo {
  return {
    event_id: new Id(`event-${workspaceId.value}-${version}`),
    aggregate_id: workspaceId,
    aggregate_version: version,
    correlation_id: new Id(`event-${workspaceId.value}-0`),
    causation_id: new Id(`event-${workspaceId.value}-0`),
    recorded_on: new POSIX(1000 + version * 1000),
  }
}

function deliver(h: ReturnType<typeof projectionsHarness>, event: AiProjectedEvent, metadata: EventInfo) {
  return withIdempotency(
    h.projections,
    { eventId: metadata.event_id, projection: PROJECTION_ENDPOINT },
    aiSetupsProjection.handler({ event, info: metadata, projections: h.projections })
  )
}

const auth = { result: "allow" as const, actor: testUser }

/** Delivers `WorkspaceProvisioned` and one `AiConnectionVerified(role: active)`, returning the ids used. */
async function seedActiveConnection(h: ReturnType<typeof projectionsHarness>) {
  const workspaceId = Id.random<"Workspace">()
  const ownerId = Id.random<"User">()
  const attemptId = Id.random<"AiAttempt">()
  const connectionId = Id.random<"AiConnection">()
  const credentialRef = Id.random<"AiSecret">()

  await deliver(
    h,
    new WorkspaceProvisioned({ type: WorkspaceProvisioned.type, aggregateId: workspaceId, ownerId }),
    info(workspaceId, 0)
  ).promise((e) => new Error(JSON.stringify(e)))

  await deliver(
    h,
    new AiConnectionVerified({
      type: AiConnectionVerified.type,
      aggregateId: workspaceId,
      attemptId,
      role: "active",
      connection: {
        connectionId,
        provider: "xai",
        method: "device",
        accountId: "hash-1",
        credentialRef,
        capabilities: { account: "acct", billing: "billing", models: [] },
        preferences: { model: "test-a", effort: "medium" },
      },
    }),
    info(workspaceId, 1)
  ).promise((e) => new Error(JSON.stringify(e)))

  return { workspaceId, connectionId, credentialRef }
}

describe("AI setups projection", () => {
  test("provisioned and later events build the projected document", async () => {
    const h = projectionsHarness()
    const workspaceId = Id.random<"Workspace">()
    const ownerId = Id.random<"User">()
    const attemptId = Id.random<"AiAttempt">()
    const connectionId = Id.random<"AiConnection">()

    await deliver(
      h,
      new WorkspaceProvisioned({ type: WorkspaceProvisioned.type, aggregateId: workspaceId, ownerId }),
      info(workspaceId, 0)
    ).promise((e) => new Error(JSON.stringify(e)))
    assert.deepEqual(h.aiSetups.get(workspaceId.value), { workspaceId, ai: initialAi })

    await deliver(
      h,
      new SetupStepCompleted({ type: SetupStepCompleted.type, aggregateId: workspaceId, step: "overview" }),
      info(workspaceId, 1)
    ).promise((e) => new Error(JSON.stringify(e)))

    await deliver(
      h,
      new AiAuthorizationStarted({
        type: AiAuthorizationStarted.type,
        aggregateId: workspaceId,
        attemptId,
        provider: "xai",
        method: "device",
        purpose: "initial",
        expiresAt: new POSIX(5000),
      }),
      info(workspaceId, 2)
    ).promise((e) => new Error(JSON.stringify(e)))

    await deliver(
      h,
      new AiConnectionVerified({
        type: AiConnectionVerified.type,
        aggregateId: workspaceId,
        attemptId,
        role: "active",
        connection: {
          connectionId,
          provider: "xai",
          method: "device",
          accountId: "hash-1",
          credentialRef: Id.random<"AiSecret">(),
          capabilities: { account: "acct", billing: "billing", models: [] },
          preferences: { model: "test-a", effort: "medium" },
        },
      }),
      info(workspaceId, 3)
    ).promise((e) => new Error(JSON.stringify(e)))

    const doc = h.aiSetups.get(workspaceId.value)
    assert.ok(doc !== undefined)
    assert.equal(doc?.ai.overviewCompleted, true)
    assert.ok(doc?.ai.active instanceof Just)
    if (doc?.ai.active instanceof Just) {
      assert.equal(doc.ai.active.value.connectionId.value, connectionId.value)
      assert.equal(doc.ai.active.value.status, "ready")
    }
  })

  test("the document holds only a credential reference, and the query view drops that reference and the account id", async () => {
    const h = projectionsHarness()
    const { workspaceId, credentialRef } = await seedActiveConnection(h)

    const doc = h.aiSetups.get(workspaceId.value)
    assert.ok(doc !== undefined)
    // The document keeps the reference (a random id, never the adapter's actual credential) ...
    assert.ok(doc?.ai.active instanceof Just)
    if (doc?.ai.active instanceof Just) assert.equal(doc.ai.active.value.credentialRef.value, credentialRef.value)

    // ... but the query view built from it never carries that reference or the account id.
    const view = toSetupView(doc!.ai, routeViews("test"))
    const viewJson = JSON.stringify(view)
    assert.equal(viewJson.includes("credentialRef"), false)
    assert.equal(viewJson.includes("accountId"), false)
    assert.equal(viewJson.includes(credentialRef.value), false)
    assert.equal(viewJson.includes("hash-1"), false)
  })

  test("duplicate delivery through withIdempotency applies the event once", async () => {
    const h = projectionsHarness()
    const workspaceId = Id.random<"Workspace">()
    const ownerId = Id.random<"User">()
    const provisioned = new WorkspaceProvisioned({ type: WorkspaceProvisioned.type, aggregateId: workspaceId, ownerId })
    const step = new SetupStepCompleted({ type: SetupStepCompleted.type, aggregateId: workspaceId, step: "overview" })

    await deliver(h, provisioned, info(workspaceId, 0)).promise((e) => new Error(JSON.stringify(e)))
    await deliver(h, step, info(workspaceId, 1)).promise((e) => new Error(JSON.stringify(e)))
    // Redelivery of the same (eventId, projection) pair: the handler must not run again.
    await deliver(h, step, info(workspaceId, 1)).promise((e) => new Error(JSON.stringify(e)))

    assert.equal(h.seen.size, 2)
    assert.equal(h.aiSetups.get(workspaceId.value)?.ai.overviewCompleted, true)
  })

  test("an AI event before its WorkspaceProvisioned predecessor is retryable and not marked delivered", async () => {
    const h = projectionsHarness()
    const workspaceId = Id.random<"Workspace">()
    const step = new SetupStepCompleted({ type: SetupStepCompleted.type, aggregateId: workspaceId, step: "overview" })

    const error = await rejection(deliver(h, step, info(workspaceId, 1)))
    assert.ok(error instanceof ErrorMustRetry)
    assert.equal(h.seen.size, 0)
    assert.equal(h.aiSetups.has(workspaceId.value), false)
  })

  test("the query handler returns the initial setup view for a missing document", async () => {
    const h = projectionsHarness()
    const response = await result(handler({ payload: {}, actor: testUser, auth, projections: h.projections }))
    assert.deepEqual(response, toSetupView(initialAi, routeViews(routeMode())))
  })

  test("the query handler maps a store failure to a generic 500 without leaking details", async () => {
    const h = projectionsHarness()
    const projections: ReadProjections = {
      ...h.projections,
      [RepoAiSetups.collectionName]: {
        ...h.projections[RepoAiSetups.collectionName],
        get: () => Future.reject({ type: "driver" as const, error: new Error("private database details") }),
      },
    }
    const error = await rejection(handler({ payload: {}, actor: testUser, auth, projections }))
    assert.match(JSON.stringify(error), /500/)
    assert.equal(JSON.stringify(error).includes("private database details"), false)
    // `getAiSetup`'s controller wires the same handler under `Auth.authenticated()`.
    assert.equal(getAiSetup.handler, handler)
  })

  test("the query handler returns the projected setup for the caller's own workspace", async () => {
    const h = projectionsHarness()
    const workspaceId = Workspace.idForOwner(testUser.userId)
    const attemptId = Id.random<"AiAttempt">()
    const connectionId = Id.random<"AiConnection">()

    await deliver(
      h,
      new WorkspaceProvisioned({ type: WorkspaceProvisioned.type, aggregateId: workspaceId, ownerId: testUser.userId }),
      info(workspaceId, 0)
    ).promise((e) => new Error(JSON.stringify(e)))
    await deliver(
      h,
      new AiConnectionVerified({
        type: AiConnectionVerified.type,
        aggregateId: workspaceId,
        attemptId,
        role: "active",
        connection: {
          connectionId,
          provider: "xai",
          method: "device",
          accountId: "hash-1",
          credentialRef: Id.random<"AiSecret">(),
          capabilities: { account: "acct", billing: "billing", models: [] },
          preferences: { model: "test-a", effort: "medium" },
        },
      }),
      info(workspaceId, 1)
    ).promise((e) => new Error(JSON.stringify(e)))

    const doc = h.aiSetups.get(workspaceId.value)
    assert.ok(doc !== undefined)

    const response = await result(handler({ payload: {}, actor: testUser, auth, projections: h.projections }))
    assert.deepEqual(response, toSetupView(doc!.ai, routeViews(routeMode())))
    assert.ok(response.active !== null)
  })

  test("the Mongo-shaped reader, writer, and repo metadata satisfy the store contract", async () => {
    const workspaceId = Id.random<"Workspace">()
    const doc = { workspaceId, ai: initialAi }
    let findOneFilter: unknown
    let upsertedDoc: unknown
    const store = {
      findOne: (_repo: unknown, filter: unknown) => {
        findOneFilter = filter
        return Future.resolve(Just(doc))
      },
      upsert: (_repo: unknown, document: unknown) => {
        upsertedDoc = document
        return Future.resolve(undefined)
      },
    } as unknown as ProjectionReader & ProjectionWriter

    const reader = RepoAiSetups.reader({ values: RepoAiSetups }, store)
    const found = await reader.get(workspaceId).promise((e) => new Error(JSON.stringify(e)))
    assert.ok(found instanceof Just)
    assert.deepEqual(findOneFilter, { _id: workspaceId.value })

    const writer = RepoAiSetups.writer({ values: RepoAiSetups }, store)
    await writer.save(doc).promise((e) => new Error(JSON.stringify(e)))
    assert.equal(upsertedDoc, doc)

    assert.equal(RepoAiSetups.toId(doc), workspaceId.value)

    let createdIndex: unknown
    const collection = {
      createIndex: (spec: unknown, options: unknown) => {
        createdIndex = { spec, options }
        return Promise.resolve("WorkspaceId_unique")
      },
    } as unknown as Collection<JsonDoc>
    await RepoAiSetups.createIndexes(collection)
    assert.deepEqual(createdIndex, {
      spec: [["workspaceId", 1]],
      options: { background: true, unique: true, name: "WorkspaceId_unique" },
    })
  })
})
