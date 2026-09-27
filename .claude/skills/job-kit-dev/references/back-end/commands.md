# Commands

A command writes events inside one `RepeatableRead` Postgres transaction through `withEventStore` (retried on version conflicts, `domain.md`). It gets no `projections`: read state through `store.try_find`/`store.find`, since the event store is the write source of truth.

API schema, controller skeleton, and `api.ts` / `index.ts` registration: `templates.md`. Auth builders: `auth.md`. New event classes: `domain.md`, then `templates.md`, then `packages/backend/src/app/events.ts`.

### Validate before opening a transaction

Resolve request-shaped validation to a `Result` first, and `.chain` into `withEventStore` only once it succeeds — a blank title never opens a transaction. From `packages/backend/src/domain/note/command/updateNote.ts:18-20`:

```ts
const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
  respond(parseTitle(payload.title))
    .chain((title) =>
      withEventStore<Response, Result<NoteError, CommandResponse>>(internalError, function* (store) {
        // ...
      })
    )
    .chain(respond)
```

### Model domain errors as a `Result` union

One error type per domain, one `toResponse` that switches on it exhaustively, and one `respond` that leaves the `Result` world at the handler's edge. From `packages/backend/src/domain/note/command/noteErrors.ts:7-42`:

```ts
type NoteError = { type: "not_found" } | { type: "blank_title" }

function toResponse(error: NoteError): Response {
  switch (error.type) {
    case "not_found":
      return json({ status: 404, content: { error: { message: "Note not found" } } })
    case "blank_title":
      return json({ status: 400, content: { error: { message: "Title cannot be empty" } } })
    default: {
      const _exhaustiveCheck: never = error
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

function respond<T>(result: Result<NoteError, T>): Future<Response, T> {
  return result.either<Future<Response, T>>(
    (error) => Future.reject(toResponse(error)),
    (ok) => Future.resolve(ok)
  )
}
```

Return `Failure(...)` from the generator; never `throw` a domain error (`packages/backend/CLAUDE.md`, "Types and errors").

### Fail from inside the generator, unwrap at the edge

`withEventStore`'s generator can return a `Result<DomainError, Res>` instead of a bare `Res`; a business-rule violation becomes `Failure(...)`, no `throw`. `.chain(respond)` after the store call turns that `Result` into the `Future<Response, Res>` the handler must return. From `packages/backend/src/domain/note/command/deleteNote.ts:18-31`:

```ts
const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
  withEventStore<Response, Result<NoteError, CommandResponse>>(internalError, function* (store) {
    const found = yield* store.try_find(Note, payload.noteId)
    if (found instanceof Nothing) return Failure({ type: "not_found" })
    // ...
    return Success({ success: true })
  }).chain(respond)
```

### Client-chosen id as the idempotency receipt

When the client picks the aggregate id, the stream itself is the command's receipt: a retried create finds the existing stream and replies with the same response instead of emitting a duplicate. From `packages/backend/src/domain/note/command/createNote.ts:16-35`:

```ts
const handler: CommandHandler<Command, CommandResponse> = ({ payload, withEventStore }) =>
  respond(parseTitle(payload.title)).chain((title) =>
    withEventStore(internalError, function* (store) {
      // The client owns the id, so the stream doubles as the command
      // receipt: a retried create finds it and gets the original reply.
      const noteId = payload.noteId
      const existing = yield* store.try_find(Note, noteId)
      if (existing instanceof Just) return { noteId }
      yield* store.emit({
        aggregate: Note,
        event: new NoteCreated({ type: NoteCreated.type, aggregateId: noteId, title, body: payload.body }),
      })
      return { noteId }
    })
  )
```

### No-op guard

Compare the requested change against the current state and skip the emit when nothing would change — `sameContent` on the aggregate, not in the handler, so the rule can't drift between commands that use it. From `packages/backend/src/domain/note/command/updateNote.ts:22-24` and `packages/backend/src/domain/note/aggregate/note.ts:47-49`:

```ts
withEventStore<Response, Result<NoteError, CommandResponse>>(internalError, function* (store) {
  const found = (yield* store.try_find(Note, payload.noteId)).chain(activeNote)
  if (found instanceof Nothing) return Failure({ type: "not_found" })
  if (sameContent(found.value, title, payload.body)) return Success({ success: true })
  // only reached when title or body actually changed
})
```

### Idempotent delete

Deleting an already-deleted note succeeds without emitting a second `NoteDeleted`, so a retried delete is safe. From `packages/backend/src/domain/note/command/deleteNote.ts:19-30`:

```ts
withEventStore<Response, Result<NoteError, CommandResponse>>(internalError, function* (store) {
  const found = yield* store.try_find(Note, payload.noteId)
  if (found instanceof Nothing) return Failure({ type: "not_found" })
  if (found.value.values.status === "Deleted") return Success({ success: true })
  yield* store.emit({
    aggregate: Note,
    event: new NoteDeleted({ type: NoteDeleted.type, aggregateId: payload.noteId }),
  })
  return Success({ success: true })
})
```

### Emit multiple aggregates atomically

Two `store.emit` calls in one generator commit or roll back together; each is guarded by a deterministic-id lookup so a repeat call is a no-op instead of a duplicate. From `packages/backend/src/domain/auth/provisionUser.ts:20-43`:

```ts
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

### Side effects outside `withEventStore`

`session` and `loginCodes` arrive as handler arguments alongside `withEventStore` (`packages/backend/src/app/handlers.ts:24-31`) for effects that aren't event-store writes: consuming a one-time code, minting a session cookie. They run outside the generator, sequenced with `.chain`. From `packages/backend/src/domain/auth/command/verifyCode.ts:16-31`:

```ts
const handler: CommandHandler<Command, CommandResponse, Result_> = ({ payload, loginCodes, session, withEventStore }) =>
  respond(parseEmail(payload.email)).chain((email) =>
    loginCodes
      .consume(email, payload.code.trim())
      .mapRej((): Response => internalServerError)
      .chain((valid) =>
        valid ?
          provisionUser(withEventStore, email).chain((userId) =>
            session
              .start(userId)
              .mapRej((): Response => internalServerError)
              .map(() => ({ userId }))
          )
        : respond<CommandResponse>(Failure({ type: "invalid_code" }))
      )
  )
```

### Command registration checklist

- [ ] Endpoint added to `api.ts` and `index.ts` — full steps: `templates.md`
- [ ] Any newly emitted event class registered in `packages/backend/src/app/events.ts` — `templates.md` event registration checklist
- [ ] `Implementation<typeof api>` (`src/index.ts`) catches a command/query bucket mismatch at build time

### Command quality gates

- [ ] `authGuard` is an `Auth.*` builder; `Auth.public()` on an endpoint that reads or writes user data needs a reason in the PR description.
- [ ] Domain errors are a typed `Result` union with `toResponse`/`respond`, not thrown `Error` subclasses.
- [ ] A business-rule failure returns `Failure(...)` from inside the generator; nothing inside `function* (store)` throws a domain error.
- [ ] Validation that doesn't need the store runs before `withEventStore`, via `respond(parse...)`.
- [ ] `yield* store.*` only, never `await`, inside `function* (store)`.
- [ ] Multi-aggregate writes happen in one `withEventStore` generator, so they commit or roll back together.
- [ ] Retried and no-op commands don't emit duplicate events — a client-chosen id, a `sameContent`-style guard, or an already-applied check.
- [ ] Side effects that aren't event-store writes (session, login codes, mailer) run through their own handler args, not inside the generator.
- [ ] New emitted event classes are registered in `packages/backend/src/app/events.ts`.
- [ ] Endpoint registered in both `api.ts` and `index.ts`.
