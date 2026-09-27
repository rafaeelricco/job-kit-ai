export {
  type EventStore,
  type DatabaseEntry,
  type EventData,
  type EventStoreDatabase,
  type WithEventStore,
  type Procedure,
  createEventStore,
  Schemas,
  CSchema,
  TSchema,
  evaluate,
  EventStoreCorruptionError,
}

import * as d from "@lib/json/decoder"

import {
  CreationEvent,
  TransformationEvent,
  type EventInfo,
  type Event,
  type Aggregate,
  Id,
  type IdOf,
  type Constructor,
  type AggregateConstructor,
} from "@be/lib/event-sourcing/event"
import { Schema } from "@lib/json/schema"
import { Encoder } from "@lib/json/encoder"
import { Decoder } from "@lib/json/decoder"
import { POSIX } from "@lib/time"
import { type Result, Failure, traverse_ } from "@lib/result"
import { type Json } from "@lib/json/types"
import { TreeMap } from "@lib/tree-map"
import { type Maybe, Just, Nothing } from "@lib/maybe"
import { Future } from "@lib/future"

/* Note [Event Store]

  The Event Store is responsible for saving new Events and fetching existing
  Events to hydrate / reconstitute Aggregates.

  The Event Store saves Events, but it does not save them directly, it first
  converts them to a SerializedEvent. The SerializedEvent is a representation of
  the Event that can be stored in a database.

  Additionally, the Event Store does not simply return aggregates, but it
  returns an Aggregate plus the last event's info, whose correlation_id is the
  default for further events appended to that Aggregate.

*/

/**
 * Raised when the event store contains an entry that can no longer be
 * decoded with the schemas currently registered for its aggregate. This is a
 * programmer/operational error (a schema was removed or changed
 * incompatibly) rather than a recoverable domain failure.
 */
class EventStoreCorruptionError extends Error {
  constructor(message = "Event store contains an entry that failed to decode.") {
    super(message)
    this.name = "EventStoreCorruptionError"
  }
}

interface EventStore_ {
  find<T extends Aggregate<string>>(cls: Constructor<T>, aggregateId: IdOf<T>): Promise<T>

  try_find<T extends Aggregate<string>>(cls: Constructor<T>, aggregateId: IdOf<T>): Promise<Maybe<T>>

  emit<T extends Aggregate<string>>(
    args: EmitArgs<T>
  ): Promise<{
    event: Event<T>
    info: EventInfo
  }>

  doesEventAlreadyExist(eventId: Id<"Event">): Promise<boolean>
}

function createEventStore(db: EventStoreDatabase, schemas: Schemas): EventStore_ {
  return new CachedEventStore(db, schemas)
}

/**
 * Run a generator-based `EventStore` procedure and produce its result as a
 * `Future`, rejecting via `onError` on failure.
 *
 * ```ts
 * withEventStore(internalError, function* (store) {
 *   const found = yield* store.try_find(Workspace, id)
 *   yield* store.emit({ aggregate: Workspace, event })
 * })
 * ```
 */
type WithEventStore = <E, T>(onError: (e: Error) => E, f: (s: EventStore) => Procedure<T>) => Future<E, T>

// -----------------------------------------------------------------------

/* A database that supports being used as an event store.
 */
interface EventStoreDatabase {
  exists(id: Id<"Event">): Promise<boolean>
  findAll<T extends Aggregate<string>>(aggregateId: IdOf<T>): Promise<DatabaseEntry[]>
  insert(entry: DatabaseEntry): Promise<void>
}

type DatabaseEntry = {
  event_id: Id<"Event">
  event_name: string
  // Version of the payload's serialized shape, not the aggregate revision.
  schema_version: number
  aggregate_id: Id<string>
  aggregate_version: number
  correlation_id: Id<"Event">
  causation_id: Id<"Event">
  recorded_on: POSIX
  payload: Json
}

/** Convenient runtime representation of data in a serialized event. */
type EventData<E> = { info: EventInfo; event: E }

// -----------------------------------------------------------------------

type LoadedAggregate<T extends Aggregate<string>> = {
  aggregate: T
  lastEvent: EventInfo
}

/*
  An instance of EventStore that caches aggregate reads.
  Because it caches stuff, it should only live for the duration
  of a single database transaction.
 */
class CachedEventStore implements EventStore_ {
  // This cache allows us to efficiently call `find` and `try_find` multiple
  // times within a transaction. This makes reactions and commands simpler as
  // there is no need to manually apply to the aggregate the transformations
  // performed by newly emitted events in those functions. Instead we can just
  // call `find` again and load the latest version of the aggregate for free.
  //
  // The cache holds aggregates of every registered type, so its value type is
  // necessarily erased to the untyped `Aggregate<string>` upper bound; looking
  // an entry back up for a specific `T` needs one narrowing cast (`cache_load`
  // below) that is only as safe as the caller passing back an id it (or the
  // database) actually produced for that `T`.
  private cache: TreeMap<Id<string>, LoadedAggregate<Aggregate<string>>>

  // An instance of this class never lives longer than the transaction
  // it is associated with.
  private database: EventStoreDatabase
  private readonly schemas: Schemas
  constructor(database: EventStoreDatabase, schemas: Schemas) {
    this.database = database
    this.schemas = schemas
    this.cache = TreeMap.new_()
  }

  async find<T extends Aggregate<string>>(cls: Constructor<T>, aggregateId: IdOf<T>): Promise<T> {
    return (await this._find(cls, aggregateId)).aggregate
  }

  async try_find<T extends Aggregate<string>>(cls: Constructor<T>, aggregateId: IdOf<T>): Promise<Maybe<T>> {
    const found = await this._try_find(cls, aggregateId)
    return found.map((f) => f.aggregate)
  }

  private async _find<T extends Aggregate<string>>(
    cls: Constructor<T>,
    aggregateId: IdOf<T>
  ): Promise<LoadedAggregate<T>> {
    const found = await this._try_find(cls, aggregateId)

    if (found instanceof Nothing) {
      throw new Error(`Unknown aggregate ID ${aggregateId.value}`)
    }

    return found.value
  }

  private async _try_find<T extends Aggregate<string>>(
    cls: Constructor<T>,
    aggregateId: IdOf<T>
  ): Promise<Maybe<LoadedAggregate<T>>> {
    const cached = this.cache_load(aggregateId)
    if (cached instanceof Just) {
      return cached
    }

    const entries = await this.database.findAll(aggregateId)

    if (entries.length === 0) {
      return Nothing()
    }

    const loaded = this.schemas.hydrate(cls, entries).either(
      (message): never => {
        throw new EventStoreCorruptionError(message)
      },
      (value) => value
    )
    this.cache_save(loaded)
    return Just(loaded)
  }

  async emit<T extends Aggregate<string>>(args: EmitArgs<T>): Promise<{ event: Event<T>; info: EventInfo }> {
    const event = args.event
    const event_id = args.event_id ?? Id.random<"Event">()
    const { info, aggregate } = await this.applyEvent(
      args.aggregate,
      event,
      event_id,
      args.correlation_id,
      args.causation_id
    )

    const entry = this.schemas.encode({ info, event })
    await this.database.insert(entry)
    this.cache_save({ aggregate, lastEvent: info })
    return { event, info }
  }

  // Compute the resulting aggregate and event metadata for either kind of
  // event, without ever assigning to a `let`: a creation event starts a fresh
  // aggregate at version 0; a transformation event advances the version by
  // constructing a brand new aggregate rather than mutating the one returned
  // by `transformAggregate`.
  private async applyEvent<T extends Aggregate<string>>(
    aggregateCls: Constructor<T>,
    event: CreationEvent<T> | TransformationEvent<T>,
    event_id: Id<"Event">,
    correlation_id: Id<"Event"> | undefined,
    causation_id: Id<"Event"> | undefined
  ): Promise<{ info: EventInfo; aggregate: T }> {
    switch (true) {
      case event instanceof CreationEvent: {
        const info: EventInfo = {
          event_id,
          aggregate_id: event.values.aggregateId,
          aggregate_version: 0,
          correlation_id: correlation_id ?? event_id,
          causation_id: causation_id ?? event_id,
          recorded_on: POSIX.now(),
        }
        return { info, aggregate: event.createAggregate(info) }
      }
      case event instanceof TransformationEvent: {
        const found = await this._find(aggregateCls, event.values.aggregateId)
        const new_version = found.aggregate.values.aggregateVersion + 1
        const info: EventInfo = {
          event_id,
          aggregate_id: found.aggregate.values.aggregateId,
          aggregate_version: new_version,
          // Correlation defaults to the stream's so an aggregate's events stay in
          // one delivery partition. Causation names the direct trigger: the
          // caller's event, or this event itself when a command caused it.
          correlation_id: correlation_id ?? found.lastEvent.correlation_id,
          causation_id: causation_id ?? event_id,
          recorded_on: POSIX.now(),
        }
        const transformed = event.transformAggregate(found.aggregate, info)
        const aggregate = new aggregateCls({
          ...transformed.values,
          aggregateVersion: new_version,
        })
        return { info, aggregate }
      }
      default:
        return event satisfies never
    }
  }

  async doesEventAlreadyExist(eventId: Id<"Event">): Promise<boolean> {
    return this.database.exists(eventId)
  }

  private cache_save<T extends Aggregate<string>>(loaded: LoadedAggregate<T>): void {
    this.cache.set(loaded.aggregate.values.aggregateId, loaded)
  }

  // The cache is keyed by the untyped `Id<string>`, so reading a value back
  // out for a specific `T` needs a narrowing cast: this is sound exactly when
  // every entry was inserted (via `cache_save`) under the id of an aggregate
  // of that same `T`, which is the only way this class ever populates it.
  private cache_load<T extends Aggregate<string>>(id: IdOf<T>): Maybe<LoadedAggregate<T>> {
    return this.cache.get(id) as Maybe<LoadedAggregate<T>>
  }
}

// -----------------------------------------------------------------------

/**
 * Schema for one creation event `E` of aggregate `A`, tagged by its `type`
 * discriminant. Register instances of this (and `TSchema`) in a `Schemas`
 * array so the event store knows how to decode and encode `E`.
 */
class CSchema<A extends Aggregate<string>, E extends CreationEvent<A>, T extends E["values"]["type"]> {
  readonly aggregate: AggregateConstructor<A>
  readonly type: T
  // The decoder/encoder are erased to the widest type that is *safe* to widen
  // to in each direction: a decoder only ever produces a value (covariant, so
  // widening its output to `unknown` is safe) and an encoder only ever
  // consumes one (contravariant, so narrowing its input to `never` is safe).
  // That is what lets heterogeneous `CSchema`/`TSchema` instances for
  // different concrete event classes share one field type without `any`.
  readonly decoder: Decoder<unknown>
  readonly encoder: Encoder<never>
  constructor(aggregate: AggregateConstructor<A>, schema: Schema<E>, type: T) {
    this.aggregate = aggregate
    this.type = type
    this.decoder = schema.decoder
    this.encoder = schema.encoder
  }
}

/** Same as `CSchema`, for a transformation event `E`. */
class TSchema<A extends Aggregate<string>, E extends TransformationEvent<A>, T extends E["values"]["type"]> {
  readonly aggregate: AggregateConstructor<A>
  readonly type: T
  readonly decoder: Decoder<unknown>
  readonly encoder: Encoder<never>
  constructor(aggregate: AggregateConstructor<A>, schema: Schema<E>, type: T) {
    this.aggregate = aggregate
    this.type = type
    this.decoder = schema.decoder
    this.encoder = schema.encoder
  }
}

type SomeSchema<A extends Aggregate<string>> =
  CSchema<A, CreationEvent<A>, string> | TSchema<A, TransformationEvent<A>, string>

/** Efficient decoders for all creation and transformation events for an aggregate. */
type Decoders<T extends Aggregate<string>> = {
  creation: Decoder<CreationEvent<T>>
  transformation: Decoder<TransformationEvent<T>>
}

type EventName = string

/* Note [Schemas]

  We need some type-safe way to decode events for an aggregate. That is, without casting.
  We perform type-directed decoding, where we specify the type of the aggregate,
  then use the decoders we have for creation and transformation events for that aggregate.

  This ensures that we will never apply an incorrect aggregate transformation or create
  an aggregate of the incorrect type.
*/
type AggregateEvents = {
  creation: Array<{ type: string; decoder: Decoder<unknown> }>
  transformation: Array<{ type: string; decoder: Decoder<unknown> }>
}

/** Registry of every aggregate's event schemas: encodes an event to a `DatabaseEntry` and hydrates an aggregate back from a stream of them. */
class Schemas {
  private cmap = new Map<Constructor<Aggregate<string>>, Decoders<Aggregate<string>>>()
  private tmap = new Map<EventName, Encoder<never>>()

  constructor(arr: Array<SomeSchema<Aggregate<string>>>) {
    const entries = Schemas.validateEntries(arr)
    Schemas.populateEncoders(this.tmap, entries)
    const emap = Schemas.groupByAggregate(entries)
    Schemas.assertUniqueAggregateTypes(emap)
    Schemas.populateDecoders(this.cmap, emap)
  }

  private static validateEntries(arr: Array<SomeSchema<Aggregate<string>>>): Array<SomeSchema<Aggregate<string>>> {
    return arr.map((entry) => {
      if (entry instanceof CSchema || entry instanceof TSchema) return entry
      throw new Error(`Value should be an instance of SomeSchema`)
    })
  }

  private static populateEncoders(
    tmap: Map<EventName, Encoder<never>>,
    entries: Array<SomeSchema<Aggregate<string>>>
  ): void {
    for (const entry of entries) {
      if (tmap.has(entry.type)) throw new Error(`Duplicate entry for ${entry.type}`)
      tmap.set(entry.type, entry.encoder)
    }
  }

  private static groupByAggregate(
    entries: Array<SomeSchema<Aggregate<string>>>
  ): Map<AggregateConstructor<Aggregate<string>>, AggregateEvents> {
    const emap = new Map<AggregateConstructor<Aggregate<string>>, AggregateEvents>()
    for (const entry of entries) {
      const found = emap.get(entry.aggregate) ?? {
        creation: [],
        transformation: [],
      }
      Schemas.appendEntry(found, entry)
      emap.set(entry.aggregate, found)
    }
    return emap
  }

  private static appendEntry(found: AggregateEvents, entry: SomeSchema<Aggregate<string>>): void {
    if (entry instanceof CSchema) {
      found.creation.push({ decoder: entry.decoder, type: entry.type })
      return
    }
    if (entry instanceof TSchema) {
      found.transformation.push({ decoder: entry.decoder, type: entry.type })
      return
    }
    entry satisfies never
  }

  private static assertUniqueAggregateTypes(emap: Map<AggregateConstructor<Aggregate<string>>, AggregateEvents>): void {
    const seen = new Set<string>()
    for (const aggregate of emap.keys()) {
      if (seen.has(aggregate.type)) throw new Error(`Duplicate aggregate type "${aggregate.type}"`)
      seen.add(aggregate.type)
    }
  }

  private static populateDecoders(
    cmap: Map<Constructor<Aggregate<string>>, Decoders<Aggregate<string>>>,
    emap: Map<AggregateConstructor<Aggregate<string>>, AggregateEvents>
  ): void {
    for (const [aggregate, events] of emap.entries()) {
      cmap.set(aggregate, {
        creation: makeDecoder(events.creation),
        transformation: makeDecoder(events.transformation),
      })
    }
  }

  encode<E extends Event<Aggregate<string>>>(edata: EventData<E>): DatabaseEntry {
    const ty = edata.event.values.type
    const found = this.tmap.get(ty)
    if (found == undefined) {
      console.error(
        `Schemas#encode: unknown event type: ${ty}.  Did you forget to register schema in src/app/events.ts?`
      )
      throw new Error(`Unknown event type ${ty}`)
    }

    // Safe exactly when `found` was registered (via `populateEncoders`) under
    // this same event type tag — the only way an entry ever lands in `tmap`.
    const encoder = found as Encoder<E>
    return encodeEntry<E>(edata, encoder)
  }

  /** Build an aggregate from all its serialized events. */
  hydrate<A extends Aggregate<string>>(
    cls: Constructor<A>,
    entries: DatabaseEntry[]
  ): Result<string, { aggregate: A; lastEvent: EventInfo }> {
    // Safe exactly when `cls` was one of the aggregate classes passed to this
    // `Schemas` registry — the only way an entry ever lands in `cmap`.
    const schemas = this.cmap.get(cls) as undefined | Decoders<A>
    if (schemas == undefined) {
      throw new Error(`Unknown aggregate ${cls.name}`)
    }

    const entry0 = entries[0]
    if (entry0 == undefined) {
      return Failure("No events")
    }

    // A stream is versions 0..n with no gaps. Anything else means history
    // was lost or reordered, and folding it would invent a state.
    const gap = entries.findIndex((e, i) => e.aggregate_version !== i)
    if (gap !== -1) {
      return Failure(`Expected aggregate_version ${gap}, found ${entries[gap]?.aggregate_version}`)
    }

    return decodeEntry(entry0, schemas.creation).chain(({ event: first, info }) =>
      traverse_(entries.slice(1), (e) => decodeEntry(e, schemas.transformation)).map((rest) =>
        rest.reduce(
          (acc, t, index) => {
            const transformed = t.event.transformAggregate(acc.aggregate, t.info)
            const aggregate = new cls({
              ...transformed.values,
              aggregateVersion: index + 1,
            })
            return { aggregate, lastEvent: t.info }
          },
          { aggregate: first.createAggregate(info), lastEvent: info }
        )
      )
    )
  }
}

/**
 * The only payload shape written so far. Bump it together with a decoder
 * that still reads every older version.
 */
const SCHEMA_VERSION = 1

function decodeEntry<A extends Event<Aggregate<string>>>(
  entry: DatabaseEntry,
  decoder: Decoder<A>
): Result<string, EventData<A>> {
  if (entry.schema_version !== SCHEMA_VERSION) {
    return Failure(`Unsupported schema version ${entry.schema_version} for ${entry.event_name}`)
  }
  return d.decode(entry.payload, decoder).map((event) => ({
    event,
    info: {
      event_id: entry.event_id,
      aggregate_id: entry.aggregate_id,
      aggregate_version: entry.aggregate_version,
      correlation_id: entry.correlation_id,
      causation_id: entry.causation_id,
      recorded_on: entry.recorded_on,
    },
  }))
}

function encodeEntry<E extends Event<Aggregate<string>>>(
  { info, event }: EventData<E>,
  encoder: Encoder<E>
): DatabaseEntry {
  return {
    event_id: info.event_id,
    event_name: event.values.type,
    schema_version: SCHEMA_VERSION,
    aggregate_id: info.aggregate_id,
    aggregate_version: info.aggregate_version,
    correlation_id: info.correlation_id,
    causation_id: info.causation_id,
    recorded_on: info.recorded_on,
    payload: encoder.run(event),
  }
}

// -----------------------------------------------------------------------

type EventTypeDecoder = { type: string; decoder: Decoder<unknown> }

/**
 * Create an efficient decoder given a list of registered event decoders,
 * dispatching on the payload's `type` tag.
 *
 * To be used when joining decoders for the Schemas registry.
 */
function makeDecoder<T>(ts: Array<EventTypeDecoder>): Decoder<T> {
  return d.object({ type: d.string }).chain(({ type: ty }) => {
    const c: undefined | EventTypeDecoder = ts.find((t) => t.type === ty)

    if (c === undefined) return d.fail(`Unknown event type: ${ty}`)

    // Safe exactly when `c` was registered under this same event type tag.
    return c.decoder as Decoder<T>
  })
}

// -----------------------------------------------------------------------

type EmitArgs<T extends Aggregate<string>> = {
  aggregate: Constructor<T>
  event: CreationEvent<T> | TransformationEvent<T>
  event_id?: Id<"Event">
  correlation_id?: Id<"Event">
  causation_id?: Id<"Event">
}

type Op =
  | {
      tag: "FIND"
      cls: Constructor<Aggregate<string>>
      aggregateId: Id<string>
    }
  | {
      tag: "TRY_FIND"
      cls: Constructor<Aggregate<string>>
      aggregateId: Id<string>
    }
  | { tag: "EMIT"; args: EmitArgs<Aggregate<string>> }
  | { tag: "DOES_EVENT_ALREADY_EXIST"; eventId: Id<"Event"> }

/* A base operation on an event store.
 * This type exists to make the operation construction opaque, preventing users
 * from creating operations without type-safety. That is, users can't directly
 * write `yield { tag: ... }`, they must use the constructing functions.
 */
class Operation {
  private readonly operation: Op
  constructor(operation: Op) {
    this.operation = operation
  }

  static operation(o: Operation): Op {
    return o.operation
  }
}

type Query<T> = Generator<Operation, T, T>

/*
 * A pure Event Store.
 * Use it to describe procedures on the event store without supporting other effects.
 */
class EventStore {
  *find<T extends Aggregate<string>>(cls: Constructor<T>, aggregateId: IdOf<T>): Query<T> {
    return yield new Operation({ tag: "FIND", cls, aggregateId })
  }

  *try_find<T extends Aggregate<string>>(cls: Constructor<T>, aggregateId: IdOf<T>): Query<Maybe<T>> {
    return yield new Operation({ tag: "TRY_FIND", cls, aggregateId })
  }

  *emit<T extends Aggregate<string>>(args: EmitArgs<T>): Query<{ event: Event<T>; info: EventInfo }> {
    return yield new Operation({ tag: "EMIT", args })
  }

  *doesEventAlreadyExist(eventId: Id<"Event">): Query<boolean> {
    return yield new Operation({ tag: "DOES_EVENT_ALREADY_EXIST", eventId })
  }
}

/** A combination of operations on the store. */
type Procedure<T> = Generator<Operation, T, unknown>

/** Run `f`'s procedure against the real `store`, executing each yielded operation and feeding its result back into the generator. */
async function evaluate<T>(store: EventStore_, f: (e: EventStore) => Procedure<T>): Promise<T> {
  const gen = f(new EventStore())
  let result = gen.next()
  while (!result.done) {
    const op = Operation.operation(result.value)
    let value: unknown
    switch (op.tag) {
      case "FIND":
        value = await store.find(op.cls, op.aggregateId)
        break
      case "TRY_FIND":
        value = await store.try_find(op.cls, op.aggregateId)
        break
      case "EMIT":
        value = await store.emit(op.args)
        break
      case "DOES_EVENT_ALREADY_EXIST":
        value = await store.doesEventAlreadyExist(op.eventId)
        break
      default:
        return op satisfies never
    }
    result = gen.next(value)
  }
  return result.value // typed as T
}
