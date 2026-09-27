# Commands

A command writes events inside one `RepeatableRead` Postgres transaction through `withEventStore` (retried on version conflicts, `domain.md`). It gets no `projections`: read state through `store.try_find`/`store.find`, since the event store is the write source of truth.

API schema, controller skeleton, and `api.ts` / `index.ts` registration: `templates.md`. Auth builders: `auth.md`. New event classes: `domain.md`, then `templates.md`, then `packages/backend/src/app/events.ts`.

### Validate before opening a transaction

Resolve request-shaped validation to a `Result` first, and `.chain` into `withEventStore` only once it succeeds — invalid input never opens a transaction. The command skeleton in `templates.md` shows the full chain (`respond(parse<Field>(payload.<field>)).chain((<field>) => withEventStore(...)).chain(respond)`).

### Model domain errors as a `Result` union

One error type per domain, one `toResponse` that switches on it exhaustively, and one `respond` that leaves the `Result` world at the handler's edge. From `packages/backend/src/domain/ai/command/aiErrors.ts:16-49`:

```ts
type AiError =
  | { type: "route_not_ready" } // 409: the route isn't offered, or has no adapter behind it yet
  | { type: "invalid_purpose" } // 409: e.g. "initial" while a connection is already active
  | { type: "attempt_not_found" } // 404: including another workspace's attempt
  | { type: "invalid_step" } // 400: a step that doesn't match the attempt's method or state
  | { type: "connection_not_found" } // 404
  | { type: "not_ready" } // 409: completing the "connect" setup step without a ready connection
  | { type: "preference_not_allowed"; reason: PreferenceError } // 422

function toResponse(error: AiError): Response {
  switch (error.type) {
    case "route_not_ready":
      return json({ status: 409, content: { error: { message: "This route isn't available yet" } } })
    // ... one case per AiError variant
    default: {
      const _exhaustiveCheck: never = error
      throw new Error(`Unknown: ${JSON.stringify(_exhaustiveCheck)}`)
    }
  }
}

function respondAi<T>(result: Result<AiError, T>): Future<Response, T> {
  return result.either<Future<Response, T>>(
    (error) => Future.reject(toResponse(error)),
    (ok) => Future.resolve(ok)
  )
}
```

Return `Failure(...)` from the generator; never `throw` a domain error (`packages/backend/CLAUDE.md`, "Types and errors").

### Fail from inside the generator, unwrap at the edge

`withEventStore`'s generator can return a `Result<DomainError, Res>` instead of a bare `Res`; a business-rule violation becomes `Failure(...)`, no `throw`. `.chain(respondAi)` after the store call turns that `Result` into the `Future<Response, Res>` the handler must return. From `packages/backend/src/domain/ai/command/completeSetupStep.ts:25-33`:

```ts
return withEventStore<Response, Result<AiError, CommandResponse>>(aiInternalError, function* (store) {
  const workspace = yield* store.find(Workspace, workspaceId)
  const decided = decideStep(workspace.values.ai, workspaceId, payload.step)
  if (decided instanceof Failure) return Failure(decided.error)
  if (!(decided.value instanceof Just)) return Success({ setup: toSetupView(workspace.values.ai, ai.routes) })
  yield* store.emit({ aggregate: Workspace, event: decided.value.value })
  const updated = yield* store.find(Workspace, workspaceId)
  return Success({ setup: toSetupView(updated.values.ai, ai.routes) })
}).chain(respondAi)
```

`decideStep` (`ai/decide.ts`) is the pure invariant check; the handler only unwraps its verdict. Splitting the decision out this way — a plain function of the aggregate's current state that returns a `Result`/`Maybe` — keeps `function* (store)` itself free of business logic.

### Client-chosen id as the idempotency receipt

When the client picks the aggregate id, the stream itself is the command's receipt: a retried create finds the existing stream and replies with the same response instead of emitting a duplicate. There's no client-chosen-id example in this codebase today — every aggregate id is derived instead (`Workspace.idForOwner`, `User.idForEmail`) — but the principle is the same one `provisionUser` uses below ("Emit multiple aggregates atomically"): look the stream up before creating it, and a repeat call finds what already exists instead of emitting a duplicate.

### No-op guard

Compare the requested change against the current state and skip the emit when nothing would change — the comparison lives in the pure decide function, not the handler, so the rule can't drift between commands that use it. From `packages/backend/src/domain/ai/decide.ts:274-299` (`decidePreferences`, used by `setPreferences.ts`):

```ts
function decidePreferences(
  ai: AiState,
  workspaceId: Id<"Workspace">,
  id: Id<"AiConnection">,
  preferences: Preferences
): Result<AiError, Maybe<AiPreferencesChanged>> {
  if (!(ai.active instanceof Just) || ai.active.value.connectionId.value !== id.value) {
    return Failure({ type: "connection_not_found" })
  }
  const active = ai.active.value
  const checked = checkPreferences(active.capabilities, preferences)
  if (checked instanceof Failure) return Failure({ type: "preference_not_allowed", reason: checked.error })
  const next = checked.value
  if (active.preferences.model === next.model && active.preferences.effort === next.effort) return Success(Nothing())
  // only reached when the model or effort actually changed
  return Success(Just(new AiPreferencesChanged({/* ... */})))
}
```

The handler (`setPreferences.ts:31-32`) turns `Nothing` into the same `Success` reply it would give after a real emit, so a resubmit is indistinguishable from the first save.

### Idempotent repeat of a terminal action

Disconnecting an already-disconnected connection succeeds without emitting a second `AiConnectionDisconnected`, so a retried disconnect is safe. From `packages/backend/src/domain/ai/decide.ts:250-267` (`decideDisconnect`, used by `disconnect.ts`):

```ts
function decideDisconnect(
  ai: AiState,
  workspaceId: Id<"Workspace">,
  id: Id<"AiConnection">
): Result<AiError, Maybe<{ event: AiConnectionDisconnected; release: Id<"AiSecret">[] }>> {
  if (ai.active instanceof Nothing) return Success(Nothing())
  if (ai.active.value.connectionId.value !== id.value) return Failure({ type: "connection_not_found" })
  return Success(
    Just({
      event: new AiConnectionDisconnected({
        type: AiConnectionDisconnected.type,
        aggregateId: workspaceId,
        connectionId: id,
      }),
      release: [ai.active.value.credentialRef],
    })
  )
}
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
