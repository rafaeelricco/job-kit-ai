export { type AmbarResponse, toResponse, Success, ErrorMustRetry, payloadDecoder, EventBusAuthMiddleware }

import * as e from "@lib/json/encoder"
import * as d from "@lib/json/decoder"
import * as s from "@lib/json/schema"

import { json } from "@be/lib/router"
import { type Response as RouterResponse } from "@be/lib/router"
import { type EventData } from "@be/lib/event-sourcing/store"
import { schema_BIGINT_as_Number, schema_TimestampTZ } from "@be/lib/postgres"
import { type EventInfo, Id } from "@be/lib/event-sourcing/event"
import { type Maybe, Just, Nothing, fromOptional } from "@lib/maybe"

type Decoder<T> = d.Decoder<T>
type Encoder<T> = e.Encoder<T>
type Schema<T> = s.Schema<T>

/** Success response from data destination. */
class Success {
  constructor() {}
}

/** Error response from data destination. */
class ErrorMustRetry {
  readonly description: string
  constructor(description: string) {
    this.description = description
  }
}

/** Response to an Ambar request sent to a Reaction or a Projection. */
type AmbarResponse = Success | ErrorMustRetry

function toResponse(r: AmbarResponse): RouterResponse {
  switch (true) {
    case r instanceof Success:
      return json({
        status: 200,
        content: { result: { success: {} } },
      })
    case r instanceof ErrorMustRetry:
      return json({
        status: 200,
        content: {
          result: {
            error: {
              class: "transient_error",
              policy: "must_retry",
              description: r.description,
            },
          },
        },
      })
    default:
      return r satisfies never
  }
}

// -----------------------------------------------------------------------

/** Serialized representation of an event. */
type Serialized<P> = s.Infer<ReturnType<typeof schema_Serialized<P>>>

const schema_Serialized = <Payload>(payload: Schema<Payload>) =>
  s.object({
    event_id: Id.schema<"Event">(),
    aggregate_id: Id.schema<string>(),
    aggregate_version: schema_BIGINT_as_Number,
    correlation_id: Id.schema<"Event">(),
    causation_id: Id.schema<"Event">(),
    recorded_on: schema_TimestampTZ,
    payload: s.stringified(payload),
  })

function toSerialized<P>({ info, event }: { info: EventInfo; event: P }): Serialized<P> {
  return { ...info, payload: event }
}

function fromSerialized<P>(serialized: Serialized<P>): {
  info: EventInfo
  event: P
} {
  const { payload, ...info } = serialized
  return { info, event: payload }
}

const schema_EventData = <E>(s: Schema<E>): Schema<EventData<E>> =>
  schema_Serialized(s).dimap(fromSerialized, toSerialized)

/** The request that Ambar sends to Reactions and Projections. */
type AmbarHttpRequest<T> = {
  data_source_id: string
  data_source_description: string
  data_destination_id: string
  data_destination_description: string
  payload: T
}

/** Create a decoder that operates on an AmbarHttpRequest. */
function payloadDecoder<E>(decoder: Decoder<E>): Decoder<EventData<E>> {
  const dummy: Encoder<E> = new e.Encoder((_) => null)
  const eschema: Schema<EventData<E>> = schema_EventData(new s.Schema(decoder, dummy))
  const reqDecoder: Decoder<AmbarHttpRequest<EventData<E>>> = d.object({
    data_source_id: d.string,
    data_source_description: d.string,
    data_destination_id: d.string,
    data_destination_description: d.string,
    payload: eschema.decoder,
  })

  return reqDecoder.map((v) => v.payload)
}

// ================================================================================
// AUTH
// ================================================================================

import { type Request, type Response, type NextFunction } from "express"
import env from "@be/app/environment"
const EVENT_BUS_USERNAME = env.EVENT_BUS_USERNAME
const EVENT_BUS_PASSWORD = env.EVENT_BUS_PASSWORD

type Credentials = { username: string; password: string }

function parseBasicAuth(authHeader: Maybe<string>): Maybe<Credentials> {
  return authHeader.chain((header) => {
    if (!header.startsWith("Basic ")) return Nothing()
    const base64Credentials = header.split(" ")[1] ?? ""
    // `Buffer.from(_, "base64")` does not throw on malformed input; it just
    // decodes as much as it can, so no try/catch boundary is needed here.
    const credentials = Buffer.from(base64Credentials, "base64").toString("utf8")
    const separator = credentials.indexOf(":")
    if (separator === -1) return Nothing()
    const username = credentials.slice(0, separator)
    const password = credentials.slice(separator + 1)
    return Just({ username, password })
  })
}

const matches = (a: Credentials, u: string, p: string) => a.username === u && a.password === p

/** Authentication for the event-bus projection endpoint. */
const EventBusAuthMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const auth = parseBasicAuth(fromOptional(req.headers.authorization))
  if (auth instanceof Nothing) return res.status(401).json({ error: "Basic authentication required" })
  if (matches(auth.value, EVENT_BUS_USERNAME, EVENT_BUS_PASSWORD)) return next()
  return res.status(401).json({ error: "Invalid credentials" })
}
