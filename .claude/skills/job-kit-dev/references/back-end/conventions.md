# Backend conventions

Compact backend reference: CQRS shape, naming, handler signatures, registration, import boundaries, review traps. Rules a reviewer checks on a diff live in `packages/backend/CLAUDE.md`; the "why" behind them is in `packages/backend/CONVENTIONS.md`.

### Backend mental model

Commands write events, projections build MongoDB read views from those events, queries read the read views, and reactions perform side effects after events commit. The reaction pipeline is not built yet; the first reaction builds it (consumers.md, "Build the reaction pipeline").

```md
- Event store: Postgres, append-only, source of truth (`packages/backend/src/lib/event-sourcing/store.ts`).
- Projections: MongoDB read views, delivered from Postgres by postie (`packages/backend/development/postie/postie.yaml`).
- Commands: write events through `withEventStore`; never update a projection directly.
- Queries: read projections through `projections[Repo.collectionName]`; no event-store access.
- Reactions: call services or emit follow-up events when events fire, delivered by postie as `kind: reaction`. Until the pipeline exists, a request-scoped side effect runs inside the command, outside `withEventStore` (`verifyCode.ts` calling `loginCodes`/`session`).
- Read-after-write inside a command: read the aggregate from `store` (`store.try_find`/`store.find` see the transaction's own uncommitted writes), not MongoDB.
```

### Backend layer map

Put job-kit-ai business rules under `domain/<area>/`, cross-cutting glue under `app/`, and generic primitives under `lib/`.

```text
packages/backend/src/
├── api.ts                     # endpoint registry: command/query buckets
├── index.ts                   # implementation, mountProjection, mountApi, Google GET routes, shutdown
├── app/
│   ├── handlers.ts            # CommandHandler, QueryHandler, *Controller, Allowed<Result>
│   ├── handleCommand.ts       # decode → guard → Session → handler
│   ├── handleQuery.ts         # decode → guard → withProjectionReader → handler
│   ├── handleProjection.ts    # decode → withIdempotency → handler
│   ├── handleReaction.ts      # (to add) decode → withIdempotency → handler with withEventStore + services
│   ├── auth/                  # policy.ts (Auth), grants.ts, README.md
│   ├── events.ts  projections.ts  projectionStore.ts  idempotency.ts
│   ├── integrations.ts        # configureDependencies(): Dependencies
│   ├── environment.ts  mailer.ts  session.ts  loginCodes.ts  engine.ts  responses.ts
├── domain/<area>/{aggregate,command,query,projection,reaction,events/<aggregate>}/
└── lib/                       # event-sourcing/, json/, future, result, maybe, router, time, event-delivery, logger
```

### Naming and path conventions

URLs use kebab-case; `api.ts` registry keys use a snake-case area prefix plus a camel-case suffix. `PlainEndpoint` is always POST (`endpoint.ts:14`); the GET routes all live outside `defineAPI` in `index.ts`: Google sign-in, the dev `/api/dev/engine` proxy, and `/docker_healthcheck`.

```md
| Concept            | File path                                                   | URL / key                                                         |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Command API        | `src/domain/<area>/command/<verbAndNoun>.api.ts`            | `/api/v1/<area>/command/<kebab-name>`, key `<area>_<verbAndNoun>` |
| Command controller | `src/domain/<area>/command/<verbAndNoun>.ts`                | same command key                                                  |
| Query API          | `src/domain/<area>/query/<verbAndNoun>.api.ts`              | `/api/v1/<area>/query/<kebab-name>`, key `<area>_query_<noun>`    |
| Query controller   | `src/domain/<area>/query/<verbAndNoun>.ts`                  | same query key                                                    |
| Aggregate          | `src/domain/<area>/aggregate/<name>.ts`                     | `static readonly type = "<PascalName>"`                           |
| Event              | `src/domain/<area>/events/<aggregate>/<verbedPastTense>.ts` | globally unique past-tense event type (e.g. `NoteCreated`)        |
| Projection         | `src/domain/<area>/projection/<plural>.ts`                  | `/api/v1/<area>/projection/<plural>`, `Repo<Plural>`              |
| Reaction           | `src/domain/<area>/reaction/<name>.ts`                      | `/api/v1/<area>/reaction/<kebab-name>`, postie `kind: reaction`   |
| Env var            | `packages/backend/src/app/environment.ts`                   | `process.env.MY_VAR` decoded to `env.MY_VAR`                      |
```

The verb prefix drops in a query key: `getNote.api.ts` registers as `note_query_note`, `listNotes.api.ts` as `note_query_notes` (`src/api.ts`).

### Command handler shape

Commands get the event-store transaction opener, the caller's session, and login-code access; there are no projections or services here.

```ts
// packages/backend/src/app/handlers.ts:24-31
const handler: CommandHandler<Command, CommandResponse> = ({
  payload,
  actor,
  auth,
  session,
  loginCodes,
  withEventStore,
}) => ...
```

See commands.md for a full worked example (`updateNote.ts`).

### Query handler shape

Queries get a read-only projection view and nothing else — no `withEventStore`, no session.

```ts
// packages/backend/src/app/handlers.ts:37-42 — no event store, no session
const handler: QueryHandler<Query, QueryResponse> = ({ payload, projections }) =>
  projections[RepoNotes.collectionName].getById(payload.noteId).mapRej((): Response => internalServerError)
```

### Projection handler shape

Projections decode accepted event classes and write MongoDB read models; they run inside one Mongo transaction per delivered event, wrapped in idempotency by `handleProjection.ts`.

```ts
// packages/backend/src/app/handleProjection.ts:24-28
type ProjectionHandler<E> = (v: {
  event: E
  info: EventInfo
  projections: WriteProjections
}) => Future<AmbarResponse, void>

// packages/backend/src/domain/note/projection/notes.ts:194-195
const handler: ProjectionHandler<Events> = ({ event, info, projections }): Future<AmbarResponse, void> =>
  apply(projections[RepoNotes.collectionName], event, info).mapRej((message) => new ErrorMustRetry(message))
```

### Reaction handler shape

Reactions perform side effects and use `withEventStore` only to emit follow-up or marker events. Their services arrive as handler arguments. The type below is what `packages/backend/src/app/handleReaction.ts` defines once it is built (consumers.md).

```ts
type ReactionHandler<E> = (v: {
  event: E
  info: EventInfo
  withEventStore: WithEventStore
  mailer: Mailer
}) => Future<AmbarResponse, void>

const handler: ReactionHandler<Events> = ({ event, mailer, withEventStore }) =>
  mailer
    .send(buildMail(event)) // buildMail: a pure function of the event
    .mapRej((err): AmbarResponse => new ErrorMustRetry(err.message))
    .chain(() =>
      withEventStore(
        (err): AmbarResponse => new ErrorMustRetry(err.message),
        function* (store) {
          /* emit marker */
        }
      )
    )
```

### Event-store generator pattern

The generator is synchronous; every event-store operation is `yield*`ed (never `await`ed), and all writes in one generator share one `RepeatableRead` Postgres transaction, retried on version conflicts (domain.md).

```ts
// packages/backend/src/domain/note/command/updateNote.ts:21-35
withEventStore<Response, Result<NoteError, CommandResponse>>(internalError, function* (store) {
  const found = (yield* store.try_find(Note, payload.noteId)).chain(activeNote)
  if (found instanceof Nothing) return Failure({ type: "not_found" })
  if (sameContent(found.value, title, payload.body)) return Success({ success: true })
  yield* store.emit({
    aggregate: Note,
    event: new NoteUpdated({
      type: NoteUpdated.type,
      aggregateId: payload.noteId,
      title,
      body: payload.body,
    }),
  })
  return Success({ success: true })
})
```

### Registration touch points

When adding a backend thing, register it in every registry TypeScript cannot infer.

```md
| Adding                 | Register in                                                                                                                                                                                                                                                                      | TypeScript catches missing?        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Command/query endpoint | `src/api.ts` and `implementation` in `src/index.ts`                                                                                                                                                                                                                              | Yes (`Implementation<typeof api>`) |
| Event class            | `packages/backend/src/app/events.ts` with `CSchema` or `TSchema`                                                                                                                                                                                                                 | No                                 |
| Projection             | `packages/backend/src/app/projections.ts` (`Repositories`, `initializeRepositories`, `ReadProjections`, `WriteProjections`, `readProjections`, `writeProjections`), `mountProjection` in `src/index.ts`, `development/postie/application.yaml`, `development/postie/postie.yaml` | No                                 |
| Reaction               | `mountReaction` in `src/index.ts`, `development/postie/application.yaml`, `development/postie/postie.yaml` (`kind: reaction`); the first one also adds `handleReaction.ts` and `mailer` in `Dependencies`                                                                        | No                                 |
| Env var                | `packages/backend/src/app/environment.ts`                                                                                                                                                                                                                                        | Yes                                |
| Aggregate              | no direct registry; the first event that references it is enough                                                                                                                                                                                                                 | n/a                                |
```

### Backend import boundary

The server's own `tsconfig.json` paths are `@be/*` → `./src/*`, `@lib/*` → `../lib/*`, `@tests/*` → `./tests/*` (the last used only under `tests/`, never from `src/`). `@lib/*` is the shared `packages/lib/`, used by both server and app, so a `@lib/...` import resolves to the same file in both builds. Server-only building blocks (event store, Postgres, Mongo, router, logger, Google) live in `packages/backend/src/lib/` and are imported as `@be/lib/...`. `packages/frontend/` imports server code through its own `@be/*` alias pointing at `../backend/src/*`, so any `.api.ts` file — and everything it imports — must stay client-safe.

```md
Safe in `.api.ts`:

- `@be/app/endpoint` (`PlainEndpoint`)
- `@be/lib/event-sourcing/event` (`Id`, `toSchema`, ...)
- `@lib/*` (the shared `packages/lib/`)

Unsafe in `.api.ts` (server-only: pulls Express, Mongo, or Postgres into the client bundle):

- `@be/lib/event-sourcing/store/postgres`, `@be/lib/postgres`, `@be/lib/mongo`, `@be/lib/router`
- `@be/app/projectionStore`, `@be/app/projections`, `@be/app/handleProjection`
- `@be/app/integrations` (`Dependencies`, `configureDependencies`)
- controller files (`handler`/`controller` exports) — only the co-located `.api.ts` is client-safe
```

A query's DTO mapper can smuggle this in: `note/query/noteSchema.ts` imports `@be/domain/note/projection/notes` for `NoteDocument`, so anything importing `noteSchema.ts` inherits `projectionStore.ts` and `handleProjection.ts`. This is why `packages/frontend/src/api/endpoints.ts` imports each `.api.ts` file individually instead of the whole `@be/api` bucket.

### Runtime pitfalls checklist

These traps often compile but fail at runtime or under event-bus retries.

```md
- Forgot event registration in `packages/backend/src/app/events.ts`.
- Forgot projection wiring in one of the 6 `packages/backend/src/app/projections.ts` places, `mountProjection`, or the two event-delivery YAML files.
- Reaction side effect is not semantically idempotent: a crash between the effect and its marker repeats the effect.
- Used `throw` for a domain error instead of `Failure(...)` inside the generator.
- Used `await` inside `function* (store)` instead of `yield*`.
- Hand-rolled a privilege check instead of an `Auth.*` builder.
- Imported client (`packages/frontend/`) code into the server, or a server-only module into a `.api.ts`.
```

### Backend review checklist

After the leaf-specific checklist:

```md
- [ ] URL path follows `/api/v1/<area>/<command|query|projection|reaction>/<kebab-name>`.
- [ ] Registry keys match between `src/api.ts` and `implementation` in `src/index.ts`.
- [ ] `actor.type` is narrowed (`"User"` vs `"Anonymous"`) before reading actor-specific fields.
- [ ] Authorization uses an `Auth.*` builder and privileges, not roles.
- [ ] Request/response schemas use `@lib/json/schema`.
- [ ] Value schemas are reused for `Id<X>`, `POSIX`, and `Duration` — see `../time.md`.
- [ ] Server code never imports from `packages/frontend/`.
- [ ] `.api.ts` stays client-safe (see import boundary above).
- [ ] Aggregate `static readonly type` is globally unique.
- [ ] Endpoint is registered in both `src/api.ts` and `src/index.ts`.
```

Leaf routing: `index.md`.
