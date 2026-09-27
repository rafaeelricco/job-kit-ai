import assert from "node:assert/strict"
import { describe, test } from "vitest"
import type * as express from "express"
import { Future } from "@lib/future"
import { controller as notesProjection, RepoNotes } from "@be/domain/note/projection/notes"
import { RepoProjectionIdempotency, type ProjectedEvent } from "@be/app/idempotency"
import { type Repositories } from "@be/app/projections"
import { handleProjection } from "@be/app/handleProjection"
import { type ProjectionWriter, type WithProjectionWriter } from "@be/app/projectionStore"
import { EventBusAuthMiddleware } from "@be/lib/event-delivery"
import env from "@be/app/environment"

type Captured = { status: number; body: unknown }
type AuthResult = { next: true } | { next: false; status: number; body: unknown }

function invoke(handler: express.Handler, body: unknown, authorization?: string): Promise<Captured> {
  return new Promise((resolve) => {
    let status = 200
    const response = {
      status(code: number) {
        status = code
        return response
      },
      set() {
        return response
      },
      json(value: unknown) {
        resolve({ status, body: value })
        return response
      },
      send(value: unknown) {
        resolve({ status, body: value })
        return response
      },
    } as unknown as express.Response
    const headers = authorization === undefined ? {} : { authorization }
    handler({ body, headers } as express.Request, response, (() => {}) as express.NextFunction)
  })
}

function runAuth(authorization?: string): Promise<AuthResult> {
  return new Promise((resolve) => {
    let status = 200
    const response = {
      status(code: number) {
        status = code
        return response
      },
      json(body: unknown) {
        resolve({ next: false, status, body })
        return response
      },
    } as unknown as express.Response
    const headers = authorization === undefined ? {} : { authorization }
    EventBusAuthMiddleware({ headers } as express.Request, response, () => resolve({ next: true }))
  })
}

describe("projection and event-bus HTTP boundaries", () => {
  test("malformed event envelopes map to an Ambar retry response before opening storage", async () => {
    let writerOpened = false
    const withWriter: WithProjectionWriter = (_onError, procedure) => {
      writerOpened = true
      return procedure({} as ProjectionWriter)
    }
    const handler = handleProjection("/notes", withWriter, {} as Repositories, notesProjection)

    const response = await invoke(handler, { payload: { event_id: "missing-envelope-fields" } })
    const body = response.body as { result: { error: { policy: string; description: string } } }
    assert.equal(response.status, 200)
    assert.equal(body.result.error.policy, "must_retry")
    assert.match(body.result.error.description, /Unable to decode event/)
    assert.equal(writerOpened, false)
  })

  test("events outside this projection are acknowledged without opening storage", async () => {
    let writerOpened = false
    const withWriter: WithProjectionWriter = (_onError, procedure) => {
      writerOpened = true
      return procedure({} as ProjectionWriter)
    }
    const handler = handleProjection("/notes", withWriter, {} as Repositories, notesProjection)
    const envelope = {
      data_source_id: "source",
      data_source_description: "source description",
      data_destination_id: "destination",
      data_destination_description: "destination description",
      payload: {
        event_id: "event-1",
        aggregate_id: "note-1",
        aggregate_version: 0,
        correlation_id: "event-1",
        causation_id: "event-1",
        recorded_on: "2026-01-02 03:04:05+00",
        payload: JSON.stringify({ type: "UnrelatedEvent" }),
      },
    }

    const response = await invoke(handler, envelope)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { result: { success: {} } })
    assert.equal(writerOpened, false)
  })

  test("a valid event updates the read model and records its delivery marker", async () => {
    const writes: Array<{ kind: string; value: unknown }> = []
    const store = {
      find: () => Future.resolve([]),
      upsert: (_repository: unknown, document: unknown) => {
        writes.push({ kind: "upsert", value: document })
        return Future.resolve(undefined)
      },
      insert: (_repository: unknown, marker: unknown) => {
        writes.push({ kind: "insert", value: marker })
        return Future.resolve(undefined)
      },
    } as unknown as ProjectionWriter
    const repositories: Repositories = {
      [RepoNotes.collectionName]: { values: RepoNotes },
      [RepoProjectionIdempotency.collectionName]: { values: RepoProjectionIdempotency },
    }
    const withWriter: WithProjectionWriter = (_onError, procedure) => procedure(store)
    const handler = handleProjection("/notes", withWriter, repositories, notesProjection)
    const envelope = {
      data_source_id: "source",
      data_source_description: "source description",
      data_destination_id: "destination",
      data_destination_description: "destination description",
      payload: {
        event_id: "event-2",
        aggregate_id: "note-2",
        aggregate_version: 0,
        correlation_id: "event-2",
        causation_id: "event-2",
        recorded_on: "2026-01-02 03:04:05+00",
        payload: JSON.stringify({ type: "NoteCreated", aggregateId: "note-2", title: "Created", body: "" }),
      },
    }

    const response = await invoke(handler, envelope)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, { result: { success: {} } })
    assert.equal(writes.length, 2)
    assert.equal(writes[0]?.kind, "upsert")
    assert.equal((writes[0]?.value as { title: string }).title, "Created")
    assert.equal(writes[1]?.kind, "insert")
    const marker = writes[1]?.value as ProjectedEvent
    assert.equal(marker.eventId.value, "event-2")
    assert.equal(marker.projection, "/notes")
  })

  test("event-bus authentication rejects missing and invalid credentials and accepts the configured pair", async () => {
    const missing = await runAuth()
    assert.deepEqual(missing, { body: { error: "Basic authentication required" }, next: false, status: 401 })

    const invalid = await runAuth("Basic " + Buffer.from("wrong:wrong").toString("base64"))
    assert.deepEqual(invalid, { body: { error: "Invalid credentials" }, next: false, status: 401 })

    const credentials = Buffer.from(env.EVENT_BUS_USERNAME + ":" + env.EVENT_BUS_PASSWORD).toString("base64")
    const accepted = await runAuth("Basic " + credentials)
    assert.deepEqual(accepted, { next: true })
  })
})
