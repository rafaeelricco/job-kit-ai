# Queries

A query reads projections only: no `withEventStore`. Registered under the `query` buckets in both `api.ts` and `index.ts`.

API schema, projection-read controller, and registration: `templates.md`. `Auth.*` guards: `auth.md`.

### Query contract: projections, no event store

Queries get the decoded payload, the caller and its guard proof, and read-only access to the projections — no `session`, no `loginCodes`, no `withEventStore`. From `packages/backend/src/app/handlers.ts:37-42`:

```ts
export type QueryHandler<Req, Res, Result extends AuthGuardResult = AuthGuardResult> = (args: {
  payload: Req
  actor: Actor
  auth: Allowed<Result>
  projections: ReadProjections
}) => Future<Response, Res>
```

### Read through the projection reader

Index into `projections` by the repo's `collectionName`, then call one of its reader methods. From `packages/backend/src/domain/note/query/getNote.ts:14-17` and `listNotes.ts:11-14`:

```ts
// getNote.ts: fetch one, then .chain into the not-found check (see below)
const handler: QueryHandler<Query, QueryResponse> = ({ payload, projections }) =>
  projections[RepoNotes.collectionName].getById(payload.noteId).mapRej((): Response => internalServerError)

// listNotes.ts: fetch many, then .map straight to the response
const handler: QueryHandler<Query, QueryResponse> = ({ projections }) =>
  projections[RepoNotes.collectionName]
    .findActive()
    .mapRej((): Response => internalServerError)
    .map((notes) => ({ notes: notes.map(toNoteDto) }))
```

### Store errors become a generic 500

Two layers hide store failures from the client, both mapping to the same reply. The pipeline passes `hideStoreError` (`packages/backend/src/app/handleQuery.ts:15`) to `withProjectionReader`, so a failure opening or running the Mongo transaction becomes `internalServerError`; inside the handler, every projection-repo call still needs its own `.mapRej((): Response => internalServerError)` because `ReadProjections` methods reject with `ProjectionStoreError`, not `Response`. Neither layer leaks the underlying error message to the client.

### DTO mapping drops internal fields

Map the projection document to the wire shape explicitly; don't return the document as-is. From `packages/backend/src/domain/note/query/noteSchema.ts:18-21`:

```ts
/** Project a read-model document onto the wire shape, dropping `status`: queries only return live notes. */
function toNoteDto(doc: NoteDocument): NoteDto {
  return { noteId: doc.noteId, title: doc.title, body: doc.body, createdAt: doc.createdAt, updatedAt: doc.updatedAt }
}
```

### Missing record: 404 via the domain `toResponse`

`.chain`, not `.mapRej`, turns "not found" into its own reply — `mapRej` would collapse it into the generic 500 alongside real store failures. From `packages/backend/src/domain/note/query/getNote.ts:18-24`:

```ts
const handler: QueryHandler<Query, QueryResponse> = ({ payload, projections }) =>
  projections[RepoNotes.collectionName]
    .getById(payload.noteId)
    .mapRej((): Response => internalServerError)
    .chain((found) =>
      found
        .chain(activeDocument)
        .maybe<Future<Response, QueryResponse>>(Future.reject(toResponse({ type: "not_found" })), (note) =>
          Future.resolve({ note: toNoteDto(note) })
        )
    )
```

Notes aren't owner-scoped yet — any authenticated user can read any note (`listNotes.ts` doesn't filter by `actor`).

### `ReadProjections` has no writer

A query's `projections` argument is typed `ReadProjections`, which only ever holds a `<Plural>Reader` (`getById`, `findActive`, ...); `WriteProjections` — the type projection handlers get — adds `save` and the idempotency repo. A query that calls `.save(...)` fails to typecheck; there's no runtime guard needed. From `packages/backend/src/app/projections.ts:28-36`:

```ts
export type ReadProjections = {
  readonly [RepoNotes.collectionName]: NotesReader
}

export type WriteProjections = {
  readonly [RepoNotes.collectionName]: NotesWriter
  readonly [RepoProjectionIdempotency.collectionName]: IdempotencyRepo
}
```

### Hot query performance

Prefer a better projection shape or a Mongo index before introducing a cache.

1. Add a MongoDB index in `Repo<Plural>.createIndexes` (`templates.md`) for the read path.
2. Denormalize into the projection document so the query is a single key lookup.
3. Discuss before adding an in-memory repo-layer cache; there's no established example yet.

### Query registration checklist

- [ ] `import { endpoint as <area>_query_<noun> } from "@be/domain/<area>/query/<verbAndNoun>.api"` added to `src/api.ts`
- [ ] `<area>_query_<noun>` added to the `query` bucket in `src/api.ts`
- [ ] `import { controller as <area>_query_<noun> } from "@be/domain/<area>/query/<verbAndNoun>"` added to `src/index.ts`
- [ ] `<area>_query_<noun>` added to `implementation.query` in `src/index.ts`

### Query quality gates

- [ ] Controller is typed `QueryController`; handler has no `withEventStore`, `session`, or `loginCodes` access.
- [ ] Reads go through `projections[Repo<Plural>.collectionName]`, never a raw Mongo call.
- [ ] Every projection-repo call maps its `ProjectionStoreError` rejection to `internalServerError` before it reaches the response type.
- [ ] A missing or inactive record is a `.chain` to a domain `toResponse`, not a `.mapRej` to the generic 500.
- [ ] The response DTO is built explicitly (drops internal fields); the projection document itself is never returned.
- [ ] Endpoint is registered in `api.ts` and `index.ts` under `query`.
