export { type ProjectionHandler, type ProjectionController, handleProjection, decodeEvent, withIdempotency }

import * as express from "express"
import * as Ambar from "@be/lib/event-delivery"

import { type Event, type Aggregate, type EventInfo } from "@be/lib/event-sourcing/event"
import { type EventData } from "@be/lib/event-sourcing/store"
import { Decoder, decode } from "@lib/json/decoder"
import { type Result, Failure } from "@lib/result"
import { Future } from "@lib/future"
import { type Maybe } from "@lib/maybe"
import { route } from "@be/lib/router"
import { type AmbarResponse } from "@be/lib/event-delivery"
import { type WriteProjections, type Repositories, writeProjections } from "@be/app/projections"
import {
  type WithProjectionWriter,
  type ProjectionStoreError,
  describeProjectionStoreError,
} from "@be/app/projectionStore"
import { RepoProjectionIdempotency, type ProjectedEvent } from "@be/app/idempotency"
import { log } from "@be/lib/logger"

/**
 * One projection's business logic for one event: given the event, its
 * envelope info, and write access to the projections, update the read
 * model. Rejects with the `AmbarResponse` to send back to the event bus.
 */
type ProjectionHandler<E> = (v: {
  event: E
  info: EventInfo
  projections: WriteProjections
}) => Future<AmbarResponse, void>

type ProjectionController<E extends Event<Aggregate<string>>> = {
  decoder: Decoder<Maybe<E>>
  handler: ProjectionHandler<E>
}

/** Tell Ambar to retry: a storage error during projection is presumed transient. */
const retryOnStoreError = (err: Error) => new Ambar.ErrorMustRetry(err.message)

/**
 * Turn a `ProjectionController` into an Express handler for the event bus:
 * decode the event, skip events already handled (`withIdempotency`), run
 * the handler inside one Mongo transaction, and reply in Ambar's format.
 */
function handleProjection<E extends Event<Aggregate<string>>>(
  endpoint: string,
  withProjectionWriter: WithProjectionWriter,
  repositories: Repositories,
  { decoder, handler }: ProjectionController<E>
): express.Handler {
  return route((req: express.Request) =>
    decodeEvent(decoder, req)
      .chain((maybeEvent) =>
        maybeEvent.maybe<Future<AmbarResponse, AmbarResponse>>(Future.resolve(new Ambar.Success()), ({ event, info }) =>
          withProjectionWriter(retryOnStoreError, (store) => {
            const projections = writeProjections(repositories, store)
            const projected = {
              eventId: info.event_id,
              projection: endpoint,
            }
            return withIdempotency(projections, projected, handler({ event, info, projections }))
          }).map((_) => new Ambar.Success())
        )
      )
      .bimap(Ambar.toResponse, Ambar.toResponse)
  )
}

/**
 * Skip `handle` if `projected` was already recorded in the idempotency log,
 * otherwise run it and record it. Guards against the event bus redelivering
 * an event the projection has already applied.
 */
function withIdempotency(
  projections: WriteProjections,
  projected: ProjectedEvent,
  handle: Future<AmbarResponse, void>
): Future<AmbarResponse, void> {
  const idempotency = projections[RepoProjectionIdempotency.collectionName]

  const onCheckError = (err: ProjectionStoreError): AmbarResponse =>
    new Ambar.ErrorMustRetry(`Unable to check idempotency repo: ${describeProjectionStoreError(err)}`)
  const onSaveError = (err: ProjectionStoreError): AmbarResponse =>
    new Ambar.ErrorMustRetry(`Unable to save to idempotency repo: ${describeProjectionStoreError(err)}`)

  const check: Future<AmbarResponse, boolean> = idempotency.exists(projected).mapRej(onCheckError)

  const save: Future<AmbarResponse, void> = idempotency.save(projected).mapRej(onSaveError)

  return check.chain((exists) => {
    if (exists) {
      log.info(`Duplicate projection ignored for event: ${projected.eventId.value} - ${projected.projection}`)
      return Future.resolve<AmbarResponse, void>(undefined)
    }
    return handle.chain((r) => save.map(() => r))
  })
}

/** Decode the event bus payload; `Nothing` for an event this projection doesn't care about. */
function decodeEvent<E>(decoder: Decoder<Maybe<E>>, req: express.Request): Future<AmbarResponse, Maybe<EventData<E>>> {
  const bodyDecoder: Decoder<EventData<Maybe<E>>> = Ambar.payloadDecoder(decoder)

  const decoded: Result<string, EventData<Maybe<E>>> = decode(req.body, bodyDecoder)

  if (decoded instanceof Failure) {
    return Future.reject(new Ambar.ErrorMustRetry(`Unable to decode event: ${decoded.error}`))
  }

  return Future.resolve(decoded.value.event.map((event) => ({ info: decoded.value.info, event })))
}
