# Templates

Copy-paste skeletons. Replace `<placeholder>` tokens, keep `.api.ts` client-safe, apply the registration checklist for the thing you add. For a live example of each skeleton, see `packages/backend/src/domain/ai/`.

Auth builders: `auth.md`. Env vars and integrations: `services.md`.

### Command API schema

Put only endpoint metadata, schemas, and schema-derived types in `src/domain/<area>/command/<verbAndNoun>.api.ts`. `PlainEndpoint` takes no `method` option: its `method` is fixed to `"post"` (`packages/backend/src/app/endpoint.ts:14`), so every command and query is POST.

```ts
export { type Command, type CommandResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"

const endpoint = new PlainEndpoint({
  path: "/api/v1/<area>/command/<kebab-name>",
  request: s.object({
    <id>: Id.schema<"<Aggregate>">(),
    <field>: s.string,
  }),
  response: s.object({ success: s.boolean }),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
```

### Command controller with event-store write

Bind the endpoint, an `Auth.*` guard, and a handler that resolves domain errors as a `Result` before opening `withEventStore`. Same shape as `packages/backend/src/domain/ai/command/setPreferences.ts:18-37`, including its no-op guard: a resubmit that changes nothing returns success without emitting (`commands.md`, "No-op guard"). The full domain-error pattern (`<Area>Errors`, `respond`, `Failure`) is in `commands.md`.

```ts
export { controller, handler }

import { Nothing } from "@lib/maybe"
import { type Result, Success, Failure } from "@lib/result"
import { Response } from "@be/lib/router"
import { type Command, type CommandResponse, endpoint } from "@be/domain/<area>/command/<verbAndNoun>.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth } from "@be/app/auth/policy"
import { <Aggregate> } from "@be/domain/<area>/aggregate/<aggregate>"
import { <Event> } from "@be/domain/<area>/events/<aggregateName>/<event>"
import { type <Area>Error, parse<Field>, internalError, respond } from "@be/domain/<area>/command/<area>Errors"

const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
  respond(parse<Field>(payload.<field>)).chain((<field>) =>
    withEventStore<Response, Result<<Area>Error, CommandResponse>>(internalError, function* (store) {
      const found = yield* store.try_find(<Aggregate>, payload.<id>)
      if (found instanceof Nothing) return Failure({ type: "not_found" })
      if (<sameState>(found.value, <field>)) return Success({ success: true }) // no-op guard, like sameContent
      yield* store.emit({
        aggregate: <Aggregate>,
        event: new <Event>({
          type: <Event>.type,
          aggregateId: payload.<id>,
          <field>,
        }),
      })
      return Success({ success: true })
    })
  ).chain(respond)

const controller: CommandController<Command, CommandResponse> = {
  endpoint,
  authGuard: Auth.authenticated(),
  handler,
}
```

### Command registration checklist

- [ ] `import { endpoint as <area>_<verbAndNoun> } from "@be/domain/<area>/command/<verbAndNoun>.api"` added to `src/api.ts`
- [ ] `<area>_<verbAndNoun>` added to the `command` bucket in `src/api.ts`
- [ ] `import { controller as <area>_<verbAndNoun> } from "@be/domain/<area>/command/<verbAndNoun>"` added to `src/index.ts`
- [ ] `<area>_<verbAndNoun>` added to `implementation.command` in `src/index.ts`
- [ ] Any new emitted event class registered in `packages/backend/src/app/events.ts` (see the event registration checklist below)
- [ ] `Implementation<typeof api>` (`src/index.ts`) fails the build on a bucket/key mismatch between `api.ts` and `index.ts` — that's the compiler's own check
- [ ] `packages/backend/tests/unit/event-server.test.ts` builds its own `impl` and expected call list against `api`; add the new key there too (`pnpm typecheck` fails until you do)

### Query API schema

Queries are POST endpoints too; their handlers read projections instead of aggregates.

```ts
export { type Query, type QueryResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"

const endpoint = new PlainEndpoint({
  path: "/api/v1/<area>/query/<kebab-name>",
  request: s.object({ <id>: Id.schema<"<Aggregate>">() }),
  response: s.object({ <field>: s.string }),
})

type Query = s.Infer<typeof endpoint.request>
type QueryResponse = s.Infer<typeof endpoint.response>
```

### Query controller over projections

Read through `projections[Repo<Plural>.collectionName]`, and map a missing record to a domain `toResponse`, not a generic 500. Same shape as `packages/backend/src/domain/ai/query/getSetup.ts` (`queries.md` covers the 404 branch this skeleton's `<field>` case doesn't need).

```ts
export { controller, handler }

import { Future } from "@lib/future"
import { Response } from "@be/lib/router"
import { type Query, type QueryResponse, endpoint } from "@be/domain/<area>/query/<verbAndNoun>.api"
import { type QueryController, type QueryHandler } from "@be/app/handlers"
import { Auth } from "@be/app/auth/policy"
import { Repo<Plural> } from "@be/domain/<area>/projection/<plural>"
import { toResponse } from "@be/domain/<area>/command/<area>Errors"
import { internalServerError } from "@be/app/responses"

const handler: QueryHandler<Query, QueryResponse> = ({ payload, projections }) =>
  projections[Repo<Plural>.collectionName]
    .getById(payload.<id>)
    .mapRej((): Response => internalServerError)
    .chain((found) =>
      found.maybe<Future<Response, QueryResponse>>(Future.reject(toResponse({ type: "not_found" })), (doc) =>
        Future.resolve({ <field>: doc.<field> })
      )
    )

const controller: QueryController<Query, QueryResponse> = { endpoint, authGuard: Auth.authenticated(), handler }
```

### Query registration checklist

- [ ] `import { endpoint as <area>_query_<noun> } from "@be/domain/<area>/query/<verbAndNoun>.api"` added to `src/api.ts`
- [ ] `<area>_query_<noun>` added to the `query` bucket in `src/api.ts`
- [ ] `import { controller as <area>_query_<noun> } from "@be/domain/<area>/query/<verbAndNoun>"` added to `src/index.ts`
- [ ] `<area>_query_<noun>` added to `implementation.query` in `src/index.ts`
- [ ] `packages/backend/tests/unit/event-server.test.ts` `impl` and expected call list updated

### Creation event

A creation event builds the first aggregate state for a stream. Same shape as `packages/backend/src/domain/workspace/events/workspace/workspaceProvisioned.ts`.

```ts
export { <EventName> }

import * as s from "@lib/json/schema"

import { EventInfo, CreationEvent, Id, toSchema } from "@be/lib/event-sourcing/event"
import { <Aggregate> } from "@be/domain/<area>/aggregate/<aggregate>"

const type = "<EventName>" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"<Aggregate>">(),
  // event payload fields
})

class <EventName> extends CreationEvent<<Aggregate>> {
  static readonly aggregate = <Aggregate>
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  createAggregate(info: EventInfo): <Aggregate> {
    return new <Aggregate>({
      aggregateId: this.values.aggregateId,
      aggregateVersion: 0,
      // initial fields from this.values and info.recorded_on
    })
  }
}
```

### Transformation event

A transformation event returns a new aggregate with changed fields. Same shape as `packages/backend/src/domain/workspace/events/workspace/setupStepCompleted.ts`.

```ts
export { <EventName> }

import * as s from "@lib/json/schema"

import { EventInfo, Id, toSchema, TransformationEvent } from "@be/lib/event-sourcing/event"
import { <Aggregate> } from "@be/domain/<area>/aggregate/<aggregate>"

const type = "<EventName>" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"<Aggregate>">(),
  // fields needed to compute the next state
})

class <EventName> extends TransformationEvent<<Aggregate>> {
  static readonly aggregate = <Aggregate>
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  transformAggregate(aggregate: <Aggregate>, info: EventInfo): <Aggregate> {
    return new <Aggregate>({
      ...aggregate.values,
      // changed fields, e.g. updatedAt: info.recorded_on
    })
  }
}
```

### Event registration checklist

Register every new event class in `packages/backend/src/app/events.ts`, with the wrapper that matches its base class.

```ts
new CSchema(<CreationEventName>.aggregate, <CreationEventName>.schema, <CreationEventName>.type)
new TSchema(<TransformationEventName>.aggregate, <TransformationEventName>.schema, <TransformationEventName>.type)
```

- [ ] Event class added to the `schemas` array in `packages/backend/src/app/events.ts`
- [ ] Never change a shipped event's schema — a stored event that no longer decodes raises `EventStoreCorruptionError`; add a new event type instead

### Aggregate

Aggregates are plain value containers rebuilt from events; business logic lives in event classes, not aggregate methods. `readonly values` is assigned in the constructor body, never as a parameter property (`erasableSyntaxOnly`). Same shape as `packages/backend/src/domain/workspace/aggregate/workspace.ts:19-30`.

```ts
export { <Aggregate> }

import { Aggregate, Id } from "@be/lib/event-sourcing/event"

type <Aggregate>Values = {
  readonly aggregateId: Id<"<Aggregate>">
  readonly aggregateVersion: number
  <field>: string
}

class <Aggregate> implements Aggregate<"<Aggregate>"> {
  static readonly type = "<Aggregate>"

  readonly values: <Aggregate>Values
  constructor(values: <Aggregate>Values) {
    this.values = values
  }

  get aggregateId(): Id<"<Aggregate>"> {
    return this.values.aggregateId
  }

  get aggregateVersion(): number {
    return this.values.aggregateVersion
  }
}
```

### Deterministic-id aggregate

For an aggregate keyed by a token, email, or other normalized seed rather than a random id: add a static `idFor<Seed>` that derives the id, so repeat commands find the same stream instead of creating a duplicate. Same shape as `packages/backend/src/domain/user/aggregate/user.ts:34-36`.

```ts
/** Deterministic from `<seed>`, so two commands claiming the same `<seed>` collide on aggregate version 0 instead of creating two streams. */
static idFor<Seed>(<seed>: string): Id<"<Aggregate>"> {
  return Id.deterministicForAggregate<"<Aggregate>", <Aggregate>>(<Aggregate>, <seed>).unwrap((message) => message)
}
```

Use it when constructing the creation event, instead of `Id.random()`:

```ts
const <aggregate>Id = <Aggregate>.idFor<Seed>(<seed>)
if (!((yield* store.try_find(<Aggregate>, <aggregate>Id)) instanceof Just))
  yield* store.emit({
    aggregate: <Aggregate>,
    event: new <EventName>({ type: <EventName>.type, aggregateId: <aggregate>Id, <seed> }),
  })
```

### Projection document, repo, and controller

A projection owns its document type, a reader/writer pair, a decoder over the events it accepts, and the handler that applies them. Mirrors `packages/backend/src/domain/ai/projection/aiSetups.ts` end to end.

```ts
export { controller, Repo<Plural>, type <Singular>Document, type <Plural>Reader, type <Plural>Writer }

import * as d from "@lib/json/decoder"
import * as m from "@lib/maybe"
import * as s from "@lib/json/schema"

import { Future } from "@lib/future"
import { type Maybe } from "@lib/maybe"
import {
  type JsonDoc,
  Collection,
  Repository,
  type ProjectionReader,
  type ProjectionWriter,
  type ProjectionStoreError,
  describeProjectionStoreError,
} from "@be/app/projectionStore"
import { ProjectionController, ProjectionHandler } from "@be/app/handleProjection"
import { AmbarResponse, ErrorMustRetry } from "@be/lib/event-delivery"
import { EventInfo, Id } from "@be/lib/event-sourcing/event"
import { accept } from "@be/lib/event-sourcing/projection"
import { <Event1> } from "@be/domain/<area>/events/<aggregateName>/<event1>"
import { <Event2> } from "@be/domain/<area>/events/<aggregateName>/<event2>"

type <Singular>Document = {
  <idField>: Id<"<Aggregate>">
  // read-model fields
}

const schema_<Singular>Document: s.Schema<<Singular>Document> = s.object({
  <idField>: Id.schema<"<Aggregate>">(),
  // matching fields
})

/** What queries get: look up, never change. */
type <Plural>Reader = {
  readonly getById: (id: Id<"<Aggregate>">) => Future<ProjectionStoreError, Maybe<<Singular>Document>>
}

/** What the projection gets: a reader that can also save. */
type <Plural>Writer = <Plural>Reader & {
  readonly save: (doc: <Singular>Document) => Future<ProjectionStoreError, void>
}

function <plural>Reader(repo: Repository<<Singular>Document>, store: ProjectionReader): <Plural>Reader {
  return { getById: (id) => store.findOne(repo, { _id: id.value }) }
}

function <plural>Writer(repo: Repository<<Singular>Document>, store: ProjectionWriter): <Plural>Writer {
  return { ...<plural>Reader(repo, store), save: (doc) => store.upsert(repo, doc) }
}

const Repo<Plural> = {
  collectionName: "<Area>_<Plural>",
  schema: schema_<Singular>Document,
  createIndexes: async (_collection: Collection<JsonDoc>): Promise<void> => {},
  toId: (doc: <Singular>Document): string => doc.<idField>.value,

  reader: <plural>Reader,
  writer: <plural>Writer,
} as const

const decoder = accept([<Event1>, <Event2>])
type Events = m.Infer<d.Infer<typeof decoder>>

function notYetProjected(id: Id<"<Aggregate>">): string {
  return `<Aggregate> ${id.value} not yet projected; will retry`
}

function <event1>Document(event: <Event1>, info: EventInfo): <Singular>Document {
  return {
    <idField>: event.values.aggregateId,
    // fields from event.values and info.recorded_on
  }
}

function save(repo: <Plural>Writer, doc: <Singular>Document): Future<string, void> {
  return repo.save(doc).mapRej(describeProjectionStoreError)
}

/** Load the document, compute its successor with the pure `next`, save it. Rejects with a retry message when the predecessor hasn't been projected yet. */
function amend(
  repo: <Plural>Writer,
  id: Id<"<Aggregate>">,
  next: (existing: <Singular>Document) => <Singular>Document
): Future<string, void> {
  return repo
    .getById(id)
    .mapRej(describeProjectionStoreError)
    .chain((found) => found.maybe(Future.reject(notYetProjected(id)), (existing) => save(repo, next(existing))))
}

function apply(repo: <Plural>Writer, event: Events, info: EventInfo): Future<string, void> {
  switch (true) {
    case event instanceof <Event1>:
      return save(repo, <event1>Document(event, info))
    case event instanceof <Event2>:
      return amend(repo, event.values.aggregateId, (existing) => ({ ...existing /* changed fields */ }))
    default:
      return event satisfies never
  }
}

const handler: ProjectionHandler<Events> = ({ event, info, projections }): Future<AmbarResponse, void> =>
  apply(projections[Repo<Plural>.collectionName], event, info).mapRej((message) => new ErrorMustRetry(message))

const controller: ProjectionController<Events> = { decoder, handler }
```

### Projection registration checklist

- [ ] `Repo<Plural>` defined in `src/domain/<area>/projection/<plural>.ts`
- [ ] `packages/backend/src/app/projections.ts`: added to `Repositories`, `initializeRepositories`, `ReadProjections`, `WriteProjections`, `readProjections`, `writeProjections`
- [ ] `src/index.ts` `mountProjection`: `app.post(path, EventBusAuthMiddleware, express.json({ limit: "5mb" }), handleProjection(path, ...))`
- [ ] `packages/backend/development/postie/application.yaml` `data_destinations` entry, `endpoint` set to the projection's path
- [ ] `packages/backend/development/postie/postie.yaml` `destinations.<Id>: { kind: projection }`
- [ ] Test fixtures that build a full projection map extended with the new repo: `projectionsHarness` in `packages/backend/tests/support/aiSetups.ts`, `packages/backend/tests/unit/app/projection-boundary.test.ts`, the `ReadProjections` stub in `packages/backend/tests/unit/domain/ai-projection.test.ts` (`pnpm typecheck` lists any you miss)
- [ ] Add a query if clients need to read the projection

### Reaction controller

A reaction subscribes to events and performs a side effect, then emits a marker event. The first reaction also builds the pipeline this skeleton imports (`packages/backend/src/app/handleReaction.ts`, `mountReaction`, `mailer` in `Dependencies`); design and wiring are in `consumers.md` ("Build the reaction pipeline").

```ts
export { controller }

import * as d from "@lib/json/decoder"
import * as m from "@lib/maybe"

import { AmbarResponse, ErrorMustRetry } from "@be/lib/event-delivery"
import { accept } from "@be/lib/event-sourcing/projection"
import { ReactionController, ReactionHandler } from "@be/app/handleReaction"
import { <Aggregate> } from "@be/domain/<area>/aggregate/<aggregate>"
import { <TriggerEvent> } from "@be/domain/<area>/events/<aggregateName>/<triggerEvent>"
import { <Marker> } from "@be/domain/<area>/events/<aggregateName>/<marker>"

const decoder = accept([<TriggerEvent>])
type Events = m.Infer<d.Infer<typeof decoder>>

const handler: ReactionHandler<Events> = ({ event, mailer, withEventStore }) =>
  mailer
    .send(buildMail(event)) // buildMail: (event) => Mail, pure
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

For a deterministic marker id (`Id.deterministicForEvent` + `store.doesEventAlreadyExist`), see `consumers.md` "Reaction idempotency choices".

### Reaction registration and idempotency checklist

Reactions wire into `index.ts` and the two postie config files, then choose semantic retry safety when a duplicate effect would matter.

- [ ] First reaction only: `packages/backend/src/app/handleReaction.ts`, `mailer: Mailer` in `Dependencies` (`packages/backend/src/app/integrations.ts`), `handleReaction.ts` in `packages/backend/tests/quality/sources.mjs`
- [ ] `<Marker>` event class created and registered in `packages/backend/src/app/events.ts`
- [ ] `mountReaction` in `src/index.ts`: `app.post(path, EventBusAuthMiddleware, express.json({ limit: "5mb" }), handleReaction(path, ...))`, before the global `express.json()`
- [ ] `packages/backend/development/postie/application.yaml` `data_destinations` entry, `endpoint` set to `/api/v1/<area>/reaction/<kebab-name>`
- [ ] `packages/backend/development/postie/postie.yaml` `destinations.<Area>_Reaction_<Name>: { kind: reaction }` (never replayed, no `replay_endpoint`)
- [ ] Idempotency strategy chosen: marker event with a state check, an inherently idempotent effect, or a deterministic marker id
- [ ] Every failure maps to `ErrorMustRetry`; the handler never throws

### Env var decoder entry

Add the entry to `envDecoder` in `packages/backend/src/app/environment.ts` before using `env.<MY_VAR>`; a dev-safe default keeps a local run working without a `.env` file.

```ts
const envDecoder = D.object({
  <MY_VAR>: optionalDefault("<dev-default>", string),
  <MY_SECRET>: optionalDefault("", string), // empty degrades in dev, refused in production — see services.md
})
```

### Env var registration checklist

- [ ] `envDecoder` entry in `packages/backend/src/app/environment.ts` with a dev-safe `optionalDefault`
- [ ] `packages/backend/development/.env.example`, and the `api.environment` block in `packages/backend/development/compose.yaml` (value shared by dev and production) or `compose.dev.yaml` (local default)
- [ ] `packages/backend/development/compose.prod.yaml`: `<MY_VAR>: ${<MY_VAR>:?set in /etc/job-kit/api.env}` when production must set it; the value itself goes in `/etc/job-kit/api.env` on the VPS, not in git
- [ ] Rationale for dev-vs-production defaults: `services.md`
