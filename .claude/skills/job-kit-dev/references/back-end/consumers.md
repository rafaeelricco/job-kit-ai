# Consumers: projections and reactions

postie delivers committed events over HTTP to consumer endpoints. Projections write MongoDB read models; reactions trigger side effects or follow-up events (their pipeline is not built yet, see below). Document/repo/handler/wiring skeletons: `templates.md`. Services a reaction calls: `services.md`. New events first: `domain.md`, then `packages/backend/src/app/events.ts`.

### Delivery and acknowledgement

postie POSTs each committed event to the destinations listed for its source (`packages/backend/development/postie/postie.yaml`, `packages/backend/development/postie/application.yaml`), at least once. The request hits `EventBusAuthMiddleware` (HTTP Basic against `EVENT_BUS_USERNAME`/`EVENT_BUS_PASSWORD`), then the route built by `handleProjection` (`packages/backend/src/app/handleProjection.ts`, `packages/backend/src/lib/event-delivery.ts`).

```ts
// packages/backend/src/lib/event-delivery.ts:19-32
class Success {
  constructor() {}
}

class ErrorMustRetry {
  readonly description: string
  constructor(description: string) {
    this.description = description
  }
}

type AmbarResponse = Success | ErrorMustRetry
```

`toResponse` (`event-delivery.ts:34-57`) turns a `Success` into `200 { result: { success: {} } }` and an `ErrorMustRetry` into `200 { result: { error: { class: "transient_error", policy: "must_retry", ... } } }` — postie only ever sees `200`; retry vs. acknowledge is decided by the JSON body, not the status code.

### Automatic per-projection idempotency

`handleProjection` wraps every projection call in `withIdempotency`, so an individual projection handler never has to guard against redelivery itself.

```ts
// packages/backend/src/app/handleProjection.ts:49-65
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
```

`withIdempotency` (`handleProjection.ts:72-95`) checks the `Idempotency` Mongo collection for `{ eventId, projection }` before running the handler, and records it after the handler succeeds; a redelivered event is logged and skipped without re-running the handler. The `(eventId, projection)` pair has a unique index (`packages/backend/src/app/idempotency.ts:36-47`, `RepoProjectionIdempotency`), so the same event can be redelivered to two different projection endpoints and each still runs exactly once. A decoder `Nothing` — an event this projection doesn't care about — short-circuits to `Success` before idempotency is even checked.

### Projection handler: create, amend, not-yet-projected retry

`accept([...])` decodes only the events this projection cares about; the handler switches on event class and calls `apply`, which returns a rejected `Future<string, void>` (never throws) for every failure mode, folded into one `ErrorMustRetry` at the boundary.

```ts
// packages/backend/src/domain/note/projection/notes.ts
const decoder = accept([NoteCreated, NoteUpdated, NoteDeleted])
type Events = m.Infer<d.Infer<typeof decoder>>

function apply(repo: NotesWriter, event: Events, info: EventInfo): Future<string, void> {
  switch (true) {
    case event instanceof NoteCreated:
      return save(repo, createdDocument(event, info))
    case event instanceof NoteUpdated:
      return amend(repo, event.values.aggregateId, (existing) => updatedDocument(existing, event, info))
    case event instanceof NoteDeleted:
      return amend(repo, event.values.aggregateId, (existing) => deletedDocument(existing, info))
    default:
      return event satisfies never
  }
}

const handler: ProjectionHandler<Events> = ({ event, info, projections }): Future<AmbarResponse, void> =>
  apply(projections[RepoNotes.collectionName], event, info).mapRej((message) => new ErrorMustRetry(message))

const controller: ProjectionController<Events> = { decoder, handler }
```

`amend` (`notes.ts:164-173`) loads the existing document and rejects with a "not yet projected; will retry" message when it isn't there — a `NoteUpdated` can be delivered before the `NoteCreated` that should have created its document has finished projecting, and that rejection becomes `ErrorMustRetry` so postie redelivers instead of the update being silently dropped.

### Projection registration

A new projection touches six places in `packages/backend/src/app/projections.ts`, plus its route in `src/index.ts`, plus both delivery YAML files.

```ts
// packages/backend/src/app/projections.ts
export type Repositories = {
  [RepoNotes.collectionName]: Repository<NoteDocument>
  [RepoProjectionIdempotency.collectionName]: Repository<ProjectedEvent>
}

export function initializeRepositories(db: Db): Future<ProjectionStoreError, Repositories> { ... }

export type ReadProjections = {
  readonly [RepoNotes.collectionName]: NotesReader
}

export type WriteProjections = {
  readonly [RepoNotes.collectionName]: NotesWriter
  readonly [RepoProjectionIdempotency.collectionName]: IdempotencyRepo
}

export function readProjections(repositories: Repositories, store: ProjectionReader): ReadProjections { ... }
export function writeProjections(repositories: Repositories, store: ProjectionWriter): WriteProjections { ... }
```

```ts
// packages/backend/src/index.ts:65-73
function mountProjection(app: express.Express, dependencies: Dependencies): void {
  const projectionPath = "/api/v1/note/projection/notes"
  app.post(
    projectionPath,
    EventBusAuthMiddleware,
    express.json({ limit: "5mb" }),
    handleProjection(projectionPath, dependencies.withProjectionWriter, dependencies.repositories, notesProjection)
  )
}
```

The projection route is mounted with its own `express.json({ limit: "5mb" })` ahead of the global parser (`createApp` in `src/index.ts`), so a large delivered event isn't rejected by the default body-size limit that applies to command/query traffic.

```yaml
# packages/backend/development/postie/application.yaml
data_destinations:
  - id: Note_Projection_Notes
    description: Notes read model
    type: http-push
    endpoint: http://api:8080/api/v1/note/projection/notes
    username: notepad_event_bus
    password: local_notepad_event_bus
    sources:
      - postgres_source
```

```yaml
# packages/backend/development/postie/postie.yaml
destinations:
  Note_Projection_Notes:
    kind: projection
```

- [ ] `Repo<Plural>` in `domain/<area>/projection/<plural>.ts`: `collectionName`, `schema`, `createIndexes`, `toId`, `reader`, `writer`.
- [ ] `Repositories`, `initializeRepositories`, `ReadProjections`, `WriteProjections`, `readProjections`, `writeProjections` in `packages/backend/src/app/projections.ts`.
- [ ] `mountProjection` in `packages/backend/src/index.ts`: `app.post(path, EventBusAuthMiddleware, express.json({ limit: "5mb" }), handleProjection(path, ...))`, mounted before the global `express.json()`.
- [ ] `data_destinations` entry in `packages/backend/development/postie/application.yaml` (`endpoint` matches the route path) and a matching `destinations.<Id>: { kind: projection }` in `packages/backend/development/postie/postie.yaml`.
- [ ] Test fixtures that build a full projection map extended: `projectionsHarness` in `packages/backend/tests/support/notes.ts`, `packages/backend/tests/unit/app/projection-boundary.test.ts`, the `ReadProjections` stub in `packages/backend/tests/unit/domain/note.test.ts`. `pnpm typecheck` lists any you miss.
- [ ] A query added if clients need to read the new projection (`queries.md`).

### Reactions: side effects after an event commits

A reaction is the other kind of consumer: postie delivers an event to it, and it performs a side effect (an email, a webhook, a follow-up command) or emits a follow-up event. Use one when the effect belongs to a business fact that already happened, rather than to the request that caused it. Examples: an application moving to `interviewing` sends the candidate a note; a posting going stale emits a reminder.

> **Pipeline not built yet.** `packages/backend/src` has no `handleReaction`, `ReactionController`, or reaction route. The first reaction adds that pipeline (see "Build the reaction pipeline" below). The shared pieces already exist: `accept` says it is for "projections and reactions" (`packages/backend/src/lib/event-sourcing/projection.ts:27`), and the idempotency log is "used both for projections and for reactions" (`packages/backend/src/app/idempotency.ts:31`). Until the pipeline exists, request-scoped side effects stay in the command, outside `withEventStore` (`requestCode.ts` → `loginCodes.send`, `verifyCode.ts` → `session.start`).

### Build the reaction pipeline

`packages/backend/src/app/handleReaction.ts` mirrors `handleProjection.ts`. It uses the same decode step, the same `withIdempotency` keyed on `(eventId, endpoint)`, and the same event-bus reply. The difference is what the handler receives: the event store and the services it calls, instead of `WriteProjections`.

```ts
// packages/backend/src/app/handleReaction.ts (to add; mirrors packages/backend/src/app/handleProjection.ts)
type ReactionHandler<E> = (v: {
  event: E
  info: EventInfo
  withEventStore: WithEventStore
  mailer: Mailer
}) => Future<AmbarResponse, void>

type ReactionController<E extends Event<Aggregate<string>>> = {
  decoder: Decoder<Maybe<E>>
  handler: ReactionHandler<E>
}

function handleReaction<E extends Event<Aggregate<string>>>(
  endpoint: string,
  withProjectionWriter: WithProjectionWriter,
  repositories: Repositories,
  services: { withEventStore: WithEventStore; mailer: Mailer },
  { decoder, handler }: ReactionController<E>
): express.Handler {
  return route((req: express.Request) =>
    decodeEvent(decoder, req)
      .chain((maybeEvent) =>
        maybeEvent.maybe<Future<AmbarResponse, AmbarResponse>>(Future.resolve(new Ambar.Success()), ({ event, info }) =>
          withProjectionWriter(retryOnStoreError, (store) =>
            withIdempotency(
              writeProjections(repositories, store),
              { eventId: info.event_id, projection: endpoint },
              handler({ event, info, ...services })
            )
          ).map((_) => new Ambar.Success())
        )
      )
      .bimap(Ambar.toResponse, Ambar.toResponse)
  )
}
```

Wiring for the first reaction:

- `mailer: Mailer` added to `Dependencies` in `packages/backend/src/app/integrations.ts`. Today `mailerFromEnv()` is built inline and handed only to `postgresLoginCodes` (`integrations.ts:119`); build it once and pass the same instance to both.
- A `mountReaction` in `packages/backend/src/index.ts`, shaped like `mountProjection`: `EventBusAuthMiddleware`, its own `express.json({ limit: "5mb" })`, mounted before the global parser.
- `handleReaction.ts` added to `criticalSources` in `packages/backend/tests/quality/sources.mjs`, next to `handleProjection`.

`withIdempotency` makes a _successful_ delivery safe to redeliver: the log row is saved only after the handler resolves. It does not cover a crash between the side effect and that save, and it does not cover a failure after the effect ran. Those need the semantic choices below.

### Reaction file: send then mark

A reaction lives in `packages/backend/src/domain/<area>/reaction/<name>.ts`. It performs the effect, then records it with a marker event, so the domain has a durable fact that the effect happened and later logic can read it. Map every failure to `ErrorMustRetry`; never throw past the boundary.

```ts
// packages/backend/src/domain/<area>/reaction/<name>.ts
const decoder = accept([<TriggerEvent>])
type Events = m.Infer<d.Infer<typeof decoder>>

const handler: ReactionHandler<Events> = ({ event, mailer, withEventStore }) =>
  mailer
    .send(buildMail(event)) // buildMail: a pure function of the event
    .mapRej((err): AmbarResponse => new ErrorMustRetry(err.message))
    .chain(() =>
      withEventStore(
        (err): AmbarResponse => new ErrorMustRetry(err.message),
        function* (store) {
          yield* store.emit({
            aggregate: <Aggregate>,
            event: new <Marker>({ type: <Marker>.type, aggregateId: event.values.aggregateId }),
          })
        }
      )
    )

const controller: ReactionController<Events> = { decoder, handler }
```

`Mailer.send` already returns `Future<Error, void>` (`packages/backend/src/app/mailer.ts:8`), so there is no promise to wrap. Every service a reaction calls arrives through its handler arguments, built once in `configureDependencies`. There is no nullable service registry: `mailerFromEnv` refuses a missing `SMTP_URL` in production and logs in development (`services.md`).

### Reaction idempotency choices

Per-endpoint idempotency is automatic; semantic idempotency is the reaction's job whenever a duplicate effect would matter. Pick one:

- **Marker event, state check first.** Emit `<Marker>` (for example `ApplicationNudgeSent`) after the effect, and have the handler `store.try_find` the aggregate and skip when its state already shows the marker. This is the default for effects a human would notice twice.
- **Inherently idempotent effect.** The effect dedupes itself: a provider idempotency key derived from `info.event_id`, an upsert, a deterministic object key. No marker is needed for safety, but you can still emit one for the domain record.
- **Deterministic marker id.** Derive the marker's event id from the triggering event's `info.event_id` and check it inside the same event-store flow, before doing anything:

```ts
withEventStore(
  (err): AmbarResponse => new ErrorMustRetry(err.message),
  function* (store) {
    const markerId = Id.deterministicForEvent(<Marker>, info.event_id.value).unwrap((message) => message)
    if (yield* store.doesEventAlreadyExist(markerId)) return

    yield* store.emit({
      aggregate: <Aggregate>,
      event_id: markerId,
      event: new <Marker>({ type: <Marker>.type, aggregateId: event.values.aggregateId }),
    })
  }
)
```

Seed with the trigger's event id, not the aggregate id: an aggregate id gives every trigger on that aggregate the same marker id, so the first marker suppresses every later legitimate effect. `Id.deterministicForEvent` (`packages/backend/src/lib/event-sourcing/event.ts:51`) returns a `Result`, so unwrap it like `deterministicForAggregate`. `emit` accepts an explicit `event_id` (`EmitArgs`, `packages/backend/src/lib/event-sourcing/store.ts:558-561`), and `store.doesEventAlreadyExist` (`store.ts:615`) reads it back. Use this form when the effect is itself an event-store write (a follow-up event). For an external effect, check the marker, perform the effect outside the generator, then emit the marker. A crash between the effect and the marker repeats the effect once, so the effect must still tolerate a duplicate.

### Reaction registration

A reaction has no projection repo, so none of the six `packages/backend/src/app/projections.ts` touch points apply. It does share the idempotency collection those touch points already create.

```ts
// packages/backend/src/index.ts, next to mountProjection
function mountReaction(app: express.Express, dependencies: Dependencies): void {
  const reactionPath = "/api/v1/<area>/reaction/<kebab-name>"
  app.post(
    reactionPath,
    EventBusAuthMiddleware,
    express.json({ limit: "5mb" }),
    handleReaction(
      reactionPath,
      dependencies.withProjectionWriter,
      dependencies.repositories,
      { withEventStore: dependencies.withEventStore, mailer: dependencies.mailer },
      <name>.controller
    )
  )
}
```

```yaml
# packages/backend/development/postie/application.yaml
data_destinations:
  - id: <Area>_Reaction_<Name>
    description: <what the side effect does>
    type: http-push
    endpoint: http://api:8080/api/v1/<area>/reaction/<kebab-name>
    username: notepad_event_bus
    password: local_notepad_event_bus
    sources:
      - postgres_source
```

```yaml
# packages/backend/development/postie/postie.yaml
destinations:
  <Area>_Reaction_<Name>:
    kind: reaction
```

postie treats `kind: reaction` as never replayable and rejects a `replay_endpoint` on it, so rebuilding a projection never re-fires a reaction's side effect. `reaction` is also postie's default kind, but name it explicitly.

### Consumer quality gates

- [ ] Decoder uses `accept([...])` with only the events this consumer handles.
- [ ] Handler maps every failure — storage errors and "not yet projected" alike — to `ErrorMustRetry`, never throws past the boundary.
- [ ] Exhaustive `switch (true)` over event classes includes `default: return event satisfies never`.
- [ ] An event that depends on prior projected state rejects (retry) rather than silently no-ops when that state isn't there yet.
- [ ] Projection registered in all six `projections.ts` spots, `mountProjection` in `index.ts`, and both `development/postie/application.yaml` + `development/postie/postie.yaml`.
- [ ] `Repo<Plural>` has `collectionName`, `schema`, `createIndexes`, and `toId`.
- [ ] The first reaction builds `handleReaction.ts`, `mountReaction`, and `mailer` in `Dependencies` before its own file.
- [ ] Reaction receives its services as handler arguments; nothing is constructed inside the handler.
- [ ] Reaction has a marker event, an idempotent external call, or a deterministic marker id whenever a duplicate effect would matter.
- [ ] Reaction registered with `mountReaction`, a `data_destinations` entry in `application.yaml`, and `kind: reaction` in `postie.yaml`.
