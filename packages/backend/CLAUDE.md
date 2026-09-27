# server

Rules a reviewer can check on a diff. Rationale and examples live in `CONVENTIONS.md` and `src/app/auth/README.md`.

## Auth

- Every `CommandController`/`QueryController` sets `authGuard` from the `Auth` builders in `src/app/auth/policy.ts`. `Auth.public()` on an endpoint that reads or writes user data needs a reason in the PR description.
- Import `grant` only inside `src/app/auth/`. Read grant data only through `getGrantData`.
- An `AuthGuard` is a pure synchronous function of `AuthContext`: no IO, `Future`, or `Promise`.
- Endpoints run through `handleCommand`/`handleQuery` (decode → guard → handler). Don't call a handler around that pipeline.

## Types and errors

- No `any`, no parameter properties (`erasableSyntaxOnly` makes them a compile error).
- Expected failures are `Result`, `Maybe`, or a rejected `Future`. `throw` only for programmer errors and platform boundaries (`JSON.parse`, `fetch`, driver calls).
- Decode external and driver data with a `Decoder`; don't cast it with `as`.

## Futures and resources

- A `Future` does nothing until forked, and forking it twice runs it twice. Don't start sessions, transactions, or queries while building one.
- Acquire connections, sessions, and transactions with `Future.bracket` (see `withConnection` in `src/lib/postgres.ts`). Cleanup runs on success, failure, and cancellation, and a transaction rolls back on every exit that doesn't commit.
- Cleanup code (release, close, `endSession`) logs and returns. It never throws, because a throw there masks the original error.

## Events

- An event is a `CreationEvent` or `TransformationEvent` whose `type` is PascalCase past tense (`NoteCreated`), built with `toSchema`, in `src/domain/<aggregate>/events/<aggregate>/`.
- Don't change a shipped event's schema: stored events that no longer decode raise `EventStoreCorruptionError`. Add a new event type instead.

## Tests

- Changes to files in `tests/quality/sources.mjs` need unit tests. The gate is 80% lines, statements, and functions, and 70% branches.
