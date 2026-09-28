# Domain: aggregates, events, and the event store

Domain files under `packages/backend/src/domain/<area>/` model aggregates, events, and the event-store transaction pattern commands use to commit business facts.

Skeletons for aggregate / creation event / transformation event: `templates.md`.

### Aggregate value container

Aggregates are state containers rebuilt from events; business mutation lives in event classes, not aggregate methods. `Aggregate<Tag>` is parameterized by the aggregate's own literal tag, never by the class itself, so `Id<"Workspace">` can't be mixed up with another aggregate's id. `erasableSyntaxOnly` forbids parameter properties, so `values` is assigned in the constructor body instead of declared on the signature.

```ts
// packages/backend/src/domain/workspace/aggregate/workspace.ts
type WorkspaceValues = {
  readonly aggregateId: Id<"Workspace">
  readonly aggregateVersion: number
  readonly ownerId: Id<"User">
  readonly createdAt: POSIX
  /** Setup progress and the AI connection registry: one active connection, at most one staged by a switch. */
  readonly ai: AiState
}

class Workspace implements Aggregate<"Workspace"> {
  static readonly type = "Workspace"

  readonly values: WorkspaceValues
  constructor(values: WorkspaceValues) {
    this.values = values
  }

  get aggregateId(): Id<"Workspace"> {
    return this.values.aggregateId
  }

  get aggregateVersion(): number {
    return this.values.aggregateVersion
  }
}
```

A field that only takes a fixed set of values should be an `as const` string tuple narrowed to a union, not a boolean or a free-form string — `ConnectionStatus` (`packages/backend/src/domain/workspace/aggregate/aiState.ts`) is `"ready" | "revoked" | "expired" | "quota_exhausted" | "unreachable"`, and adding a state is a one-line change callers' switches catch.

### Creation and transformation events

An event is a `CreationEvent<Agg>` or `TransformationEvent<Agg>`, named PascalCase past tense (`WorkspaceProvisioned`, `SetupStepCompleted`), and lives in `src/domain/<area>/events/<aggregate>/<eventName>.ts`. `toSchema` ties the class to its own `args` schema so the schema's decoded type and the class's `values` type can't drift apart.

```ts
// packages/backend/src/domain/workspace/events/workspace/workspaceProvisioned.ts
const type = "WorkspaceProvisioned" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"Workspace">(),
  ownerId: Id.schema<"User">(),
})

class WorkspaceProvisioned extends CreationEvent<Workspace> {
  static readonly aggregate = Workspace
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  createAggregate(info: EventInfo): Workspace {
    return new Workspace({
      aggregateId: this.values.aggregateId,
      aggregateVersion: 0,
      ownerId: this.values.ownerId,
      createdAt: info.recorded_on,
      ai: initialAi,
    })
  }
}
```

A `TransformationEvent` implements `transformAggregate(aggregate, info)` instead of `createAggregate(info)`, spreading the prior `values` and overriding only what changed (`packages/backend/src/domain/workspace/events/workspace/setupStepCompleted.ts:27-29`). `SetupStepCompleted` carries only `step`; it doesn't remove or replace the connection registry, only marks a setup step done in `AiState`.

### Register events

Every new event class is registered in `packages/backend/src/app/events.ts` with the wrapper that matches its base class, so `Schemas` can encode and decode it by type name.

```ts
// packages/backend/src/app/events.ts
export const schemas = new Schemas([
  new CSchema(UserRegistered.aggregate, UserRegistered.schema, UserRegistered.type),
  new CSchema(UserJoined.aggregate, UserJoined.schema, UserJoined.type),
  new CSchema(WorkspaceProvisioned.aggregate, WorkspaceProvisioned.schema, WorkspaceProvisioned.type),
  new TSchema(SetupStepCompleted.aggregate, SetupStepCompleted.schema, SetupStepCompleted.type),
  // ... one CSchema/TSchema pair per registered event class
])
```

### Shipped schemas are frozen

Don't change a shipped event's schema in place: an entry already on disk that no longer decodes against the current schema raises `EventStoreCorruptionError` the next time that aggregate is loaded (`packages/backend/src/lib/event-sourcing/store.ts:60-65`, thrown from `hydrate`/`_try_find`). Add a new event type instead. `UserRegistered` (`packages/backend/src/domain/user/events/user/userRegistered.ts`) is a live example: password sign-in is gone and nothing emits it anymore, but it stays registered in `events.ts` because old `User` streams may still contain one, and removing the schema would make those streams fail to load (`packages/backend/CLAUDE.md` Events).

### Uniqueness through a deterministic aggregate id

`Id.deterministicForAggregate<Tag, A>(aggregateClass, seed)` hashes `` `${aggregateClass.type}:${seed}` `` into an `Id<Tag>` (`packages/backend/src/lib/event-sourcing/event.ts:43-48`), so the same seed always names the same stream — no separate uniqueness sentinel or index to keep in sync. It returns a `Result<string, Id<Tag>>`, so call sites `.unwrap(...)` it into an `Id` at the boundary. The emptiness check runs on the prefixed `` `${type}:${seed}` `` string, so it never actually fails: an empty seed still yields an id, and normalizing and validating the seed is the caller's job.

```ts
// packages/backend/src/domain/user/aggregate/user.ts:34-36
static idForEmail(email: string): Id<"User"> {
  return Id.deterministicForAggregate<"User", User>(User, email).unwrap((message) => message)
}
```

`Workspace.idForOwner(ownerId)` does the same, seeded on the owner's `Id<"User">` value (`packages/backend/src/domain/workspace/aggregate/workspace.ts:30-32`). Two racing first sign-ins for the same email both compute the same `userId` and both try to create a `User` at aggregate version 0; the store's serialization retry (below) reruns the loser, whose `try_find` then sees the winner's stream and skips the create.

### Event store operations

`withEventStore` opens one transaction and drives a synchronous generator built from the `EventStore` class's operations (`packages/backend/src/lib/event-sourcing/store.ts:602-618`). Use store methods through `yield*`; never `await` inside `function* (store)` — the generator only understands its own `Operation` values, not promises.

```ts
withEventStore(internalError, function* (store) {
  const required = yield* store.find(Workspace, workspaceId) // throws if missing
  const optional = yield* store.try_find(Workspace, workspaceId) // Maybe<Workspace>
  yield* store.emit({ aggregate: Workspace, event }) // persists and updates the cache
  const seen = yield* store.doesEventAlreadyExist(eventId) // by event id
  // ...
})
```

Command error-mapping and emit examples: `commands.md`.

### Read your own write

`CachedEventStore` caches every aggregate it loads or emits for the lifetime of the transaction (`packages/backend/src/lib/event-sourcing/store.ts:149,279-289`), so a later `find`/`try_find` in the same `function*` sees an emit made earlier in that same procedure without a round trip.

```ts
withEventStore(internalError, function* (store) {
  yield* store.emit({
    aggregate: Workspace,
    event: new WorkspaceProvisioned({ type: WorkspaceProvisioned.type, aggregateId: workspaceId, ownerId }),
  })
  const justCreated = yield* store.find(Workspace, workspaceId)
  // ...
})
```

### RepeatableRead and serialization retries

`evaluate` in `packages/backend/src/lib/event-sourcing/store/postgres.ts:32-49` opens the transaction at `RepeatableRead` isolation. `retrying` (`store/postgres.ts:57-64`) re-runs the whole transaction, up to `MAX_RETRIES = 10` attempts total, when the failure is retryable: a Postgres `SerializationError`, or a `ConstraintViolationError` on the `aggregate_id, aggregate_version` unique index (`AGGREGATE_VERSION_INDEX`, `store/postgres.ts:66-77`) — two concurrent emits to the same aggregate stream racing for the same next version. Anything else propagates immediately; there's no backoff, since these conflicts are expected to be cheap and unrelated to load.

### Multi-aggregate atomic emit

Multiple aggregate streams can be updated in one transaction; all emits commit or all roll back together.

```ts
// packages/backend/src/domain/auth/provisionUser.ts:20-43
function provisionUser(withEventStore: WithEventStore, email: string): Future<Response, Id<"User">> {
  return withEventStore(
    () => internalServerError,
    function* (store) {
      const userId = User.idForEmail(email)
      if (!((yield* store.try_find(User, userId)) instanceof Just))
        yield* store.emit({
          aggregate: User,
          event: new UserJoined({ type: UserJoined.type, aggregateId: userId, email }),
        })
      const workspaceId = Workspace.idForOwner(userId)
      if (!((yield* store.try_find(Workspace, workspaceId)) instanceof Just))
        yield* store.emit({
          aggregate: Workspace,
          event: new WorkspaceProvisioned({
            type: WorkspaceProvisioned.type,
            aggregateId: workspaceId,
            ownerId: userId,
          }),
        })
      return userId
    }
  )
}
```

Both ids are derived, so a repeat sign-in finds what already exists and emits nothing; a first sign-in creates the `User` and its `Workspace` in the same transaction, so a caller can never observe one without the other.

### Domain change quality gates

- [ ] New aggregate has a globally unique `static readonly type` and implements `Aggregate<Tag>` for its own literal tag.
- [ ] `values` is assigned in the constructor body, not declared as parameter properties.
- [ ] Creation events extend `CreationEvent<Agg>` and implement `createAggregate`; transformation events extend `TransformationEvent<Agg>` and implement `transformAggregate`.
- [ ] Event class built with `toSchema(this, args)`, filed under `src/domain/<area>/events/<aggregate>/`.
- [ ] Event registered in `packages/backend/src/app/events.ts` with `CSchema` or `TSchema`.
- [ ] A shipped event's schema is never edited in place; a changed shape is a new event type.
- [ ] Deterministic aggregate ids use `Id.deterministicForAggregate(Class, seed).unwrap(...)`, not a separate uniqueness index.
- [ ] No `await` inside `function* (store)`.
- [ ] Domain errors are typed and mapped at the `withEventStore` boundary, not thrown as the control-flow mechanism (`commands.md`).
