import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Future } from "@lib/future"
import { type WriteProjections } from "@be/app/projections"
import { RepoProjectionIdempotency } from "@be/app/idempotency"
import { withIdempotency } from "@be/app/handleProjection"
import { ErrorMustRetry, type AmbarResponse } from "@be/lib/event-delivery"
import { Id } from "@be/lib/event-sourcing/event"
import { projectionsHarness, rejection } from "@tests/support/notes"

describe("projection idempotency failures", () => {
  test("an idempotency lookup failure becomes retryable without running the projection", async () => {
    const h = projectionsHarness()
    const projected = { eventId: new Id<"Event">("check-failed"), projection: "/notes" }
    const idempotency = h.projections[RepoProjectionIdempotency.collectionName]
    const projections: WriteProjections = {
      ...h.projections,
      [RepoProjectionIdempotency.collectionName]: {
        ...idempotency,
        exists: () => Future.reject({ type: "driver", error: new Error("lookup failed") }),
      },
    }
    let handled = false
    const handle = Future.create<AmbarResponse, void>((_reject, resolve) => {
      handled = true
      resolve(undefined)
    })

    const error = await rejection(withIdempotency(projections, projected, handle))
    assert.ok(error instanceof ErrorMustRetry)
    assert.equal(error.description, "Unable to check idempotency repo: lookup failed")
    assert.equal(handled, false)
    assert.equal(h.seen.size, 0)
  })

  test("a marker save failure is retryable after the projection runs", async () => {
    const h = projectionsHarness()
    const projected = { eventId: new Id<"Event">("save-failed"), projection: "/notes" }
    const idempotency = h.projections[RepoProjectionIdempotency.collectionName]
    const projections: WriteProjections = {
      ...h.projections,
      [RepoProjectionIdempotency.collectionName]: {
        ...idempotency,
        exists: () => Future.resolve(false),
        save: () => Future.reject({ type: "driver", error: new Error("marker write failed") }),
      },
    }
    let handled = false
    const handle = Future.create<AmbarResponse, void>((_reject, resolve) => {
      handled = true
      resolve(undefined)
    })

    const error = await rejection(withIdempotency(projections, projected, handle))
    assert.ok(error instanceof ErrorMustRetry)
    assert.equal(error.description, "Unable to save to idempotency repo: marker write failed")
    assert.equal(handled, true)
    assert.equal(h.seen.size, 0)
  })

  test("an existing marker skips the handler", async () => {
    const h = projectionsHarness()
    const projected = { eventId: new Id<"Event">("already-seen"), projection: "/notes" }
    h.seen.add("already-seen//notes")
    let handled = false
    const handle = Future.create<AmbarResponse, void>((_reject, resolve) => {
      handled = true
      resolve(undefined)
    })

    await new Promise<void>((resolve, reject) =>
      withIdempotency(h.projections, projected, handle).fork(reject, resolve)
    )
    assert.equal(handled, false)
  })
})
