export {
  type Event,
  type Aggregate,
  type IdOf,
  type Constructor,
  type AggregateConstructor,
  TransformationEvent,
  CreationEvent,
  type EventInfo,
  EventInfo_schema,
  Id,
  toSchema,
}

import * as s from "@lib/json/schema"

import { POSIX } from "@lib/time"
import { createId } from "@paralleldrive/cuid2"
import { sha256 } from "js-sha256"
import { type Result, Success, Failure } from "@lib/result"

type Schema<T> = s.Schema<T>

const ID_LENGTH = 50

/**
 * A reusable, nominally-tagged entity id. `Tag` is a phantom string literal
 * (e.g. "Note", "Event") — never assigned, only used to keep `Id<"Note">`
 * and `Id<"Event">` from being assignable to one another.
 */
class Id<Tag extends string> {
  declare private readonly _tag: Tag
  readonly value: string
  constructor(value: string) {
    this.value = value
  }

  static random<Tag extends string>(): Id<Tag> {
    return new Id(createId())
  }

  /** Derive an id for `aggregateClass` from `seed`, so replays produce the same id every time. */
  static deterministicForAggregate<Tag extends string, A extends Aggregate<Tag>>(
    aggregateClass: AggregateConstructor<A>,
    seed: string
  ): Result<string, Id<Tag>> {
    return deterministic<Tag>(`${aggregateClass.type}:${seed}`)
  }

  /** Same as `deterministicForAggregate`, for event ids. */
  static deterministicForEvent(eventClass: { type: string }, seed: string): Result<string, Id<"Event">> {
    return deterministic<"Event">(`${eventClass.type}:${seed}`)
  }

  static schema<Tag extends string>(): Schema<Id<Tag>> {
    return s.string.dimap(
      (v) => new Id<Tag>(v),
      (id) => id.value
    )
  }

  /** Lexicographic ordering, for use in ordered structures like `TreeMap`. */
  compare(other: Id<Tag>): -1 | 0 | 1 {
    return this.value > other.value ? 1 : this.value === other.value ? 0 : -1
  }
}

/**
 * Deterministically derive an id from a seed. Fails on an empty seed instead
 * of throwing — callers decide how to report a programmer error upstream.
 */
function deterministic<Tag extends string>(seed: string): Result<string, Id<Tag>> {
  if (seed.trim() === "") {
    return Failure("Seed cannot be empty")
  }

  // js-sha256 returns a hex string
  const hashHex = sha256(seed)
  const bigIntValue = BigInt("0x" + hashHex)
  const encoded = bigIntValue.toString(36)

  return Success(new Id<Tag>(encoded.padStart(ID_LENGTH, "0")))
}

/**
 * Interface which all aggregates implement. Used for type constraints.
 * Parameterized only by the aggregate's literal tag (e.g. "Note") — never by
 * the aggregate class itself, which would make `Id<Note>` structurally equal
 * to `Id<AnyOtherClassShapedLikeNote>`.
 */
interface Aggregate<Tag extends string> {
  readonly values: {
    readonly aggregateId: Id<Tag>
    readonly aggregateVersion: number
  }
}

/**
 * The id type of a concrete aggregate, derived from its own `values` shape
 * rather than tagged with the aggregate class (e.g. `IdOf<Note>` is
 * `Id<"Note">`, not the disallowed `Id<Note>`).
 */
type IdOf<T extends Aggregate<string>> = T["values"]["aggregateId"]

/** The literal tag of a concrete aggregate, derived the same way. */
type TagOf<T extends Aggregate<string>> = T["values"]["aggregateId"] extends Id<infer Tag extends string> ? Tag : never

/**
 * `Constructor`/`AggregateConstructor` are class references, never invoked
 * through this alias with the erased parameter list — `any[]` here (rather
 * than `unknown[]`) is the standard, deliberately variance-defeating idiom
 * for "some concrete constructor" (mixin-style) references; a narrower
 * signature genuinely cannot be assigned into `unknown[]`.
 */
type Constructor<T> = new (...args: any[]) => T
/** A `Constructor` that also carries its aggregate's literal `type` tag. */
type AggregateConstructor<A extends Aggregate<string>> = Constructor<A> & {
  readonly type: TagOf<A>
}

/** Class which all events derive from. Used for type constraints. */
abstract class Event<T extends Aggregate<string>> {
  abstract values: {
    type: string
    aggregateId: IdOf<T>
  }
}

/** The first event for an aggregate. */
abstract class CreationEvent<T extends Aggregate<string>> extends Event<T> {
  /** Build the initial aggregate state from this event. */
  abstract createAggregate(info: EventInfo): T
}

/** Any event that is not the first one for an aggregate. */
abstract class TransformationEvent<T extends Aggregate<string>> extends Event<T> {
  /** Apply this event to `aggregate`, producing its next state. */
  abstract transformAggregate(aggregate: T, info: EventInfo): T
}

/** Information about an event. Not the event payload. */
type EventInfo = s.Infer<typeof EventInfo_schema>

const EventInfo_schema = s.object({
  event_id: Id.schema<"Event">(),
  aggregate_id: Id.schema<string>(),
  aggregate_version: s.number,
  correlation_id: Id.schema<"Event">(),
  causation_id: Id.schema<"Event">(),
  recorded_on: POSIX.schema,
})

/**
 * Create an event's schema.
 * Enforces that the class' `type` property has
 * the same type as the instance's `value.type` property.
 */
function toSchema<T extends string, W extends { type: T }, E extends { values: W }>(
  ctr: (new (values: W) => E) & { type: T },
  schemaArgs: Schema<W>
): Schema<E> {
  return schemaArgs.dimap(
    (v) => new ctr(v),
    (v) => v.values
  )
}
