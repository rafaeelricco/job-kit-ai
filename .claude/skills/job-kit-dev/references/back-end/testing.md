# Testing

Server tests run on Vitest. Files are auto-discovered by `packages/backend/vitest.config.ts` (`tests/{unit,regression,quality}/**/*.test.ts`); the integration suite uses its own config and runs against the real Compose stack. Procedures (CRUD walkthrough, projection recovery, container recreation, adding a regression) are in `packages/backend/tests/README.md` — this leaf covers how tests are structured and what fixtures to reach for.

### Run the right tier

From `packages/backend/`:

```bash
pnpm test              # tests/{unit,regression,quality}/**/*.test.ts — no real DB
pnpm test:unit         # tests/unit only
pnpm test:regression   # tests/regression only
pnpm test:coverage     # pnpm test with the critical-source coverage gate
pnpm test -t "delete"  # one test by name, any tier
```

`test:integration` needs the full Compose stack (Postgres, MongoDB, Kafka, postie) and runs inside the `api` container — see `packages/backend/tests/README.md` for the exact `pnpm run up` / `docker compose exec` sequence. Integration tests drive real HTTP and a real Postgres `Pool` through `createLiveFixture()` (`packages/backend/tests/support/live.ts`: `call`, `eventually`, `history`, `seedLoginCode`, `deliver`, `withRestoredSubscription`). `test:coverage:all` (informational, all sources) and `test:mutation` (Stryker) are nightly/manual checks, not part of `pnpm quality`.

### Write a test with `describe`/`test` and `node:assert/strict`

Use Vitest's `describe`/`test`, not a custom runner, and assert with `node:assert/strict`.

```ts
// packages/backend/tests/unit/domain/note.test.ts:1-3, 30-44
import assert from "node:assert/strict"
import { describe, test } from "vitest"

describe("Notes", () => {
  test("create trims only title and preserves body including whitespace", async () => {
    const db = new MemoryEventDatabase()
    const noteId = await newNote(db, "  shopping  ", "  milk\n")
    assert.equal(db.entries.length, 1)
    assert.equal(db.entries[0]?.event_name, "NoteCreated")
    // ...
  })
})
```

### Build a command test with the memory fixtures

`packages/backend/tests/support/memory.ts` gives each dependency an in-memory twin:

- `MemoryEventDatabase` (`memory.ts:16-47`) implements `EventStoreDatabase` over an in-memory array and wires its own `withEventStore`, so `store.emit`/`try_find`/`find` run through the real event-sourcing code — only persistence is replaced.
- `MemorySessionStore` (`memory.ts:50-67`) and `MemoryLoginCodes` (`memory.ts:70-80`) implement `SessionStore` and `LoginCodes` as plain maps: no token hashing, no HMAC, no cooldown or attempt limit. Those rules are covered by the integration suite and `packages/backend/tests/unit/app/login-codes.test.ts`.

`packages/backend/tests/support/auth.ts` builds the request context a handler receives once a guard already allowed it:

```ts
// packages/backend/tests/support/auth.ts:7-15
export const testUser: UserActor = { type: "User", userId: new Id<"User">("test-user") }
export const asUser = { actor: testUser, auth: { result: "allow" } as const }
export function asUserCommand(sessions = new MemorySessionStore()) {
  return { ...asUser, session: new Session(sessions, Nothing()), loginCodes: new MemoryLoginCodes() }
}
```

Spread `asUser` into a `QueryHandler` call, `asUserCommand()` into a `CommandHandler` call, and pass a fresh `MemoryEventDatabase().withEventStore` as `withEventStore`.

### Reuse the note test helpers for a new domain area

`packages/backend/tests/support/notes.ts` is domain-specific, but its shape is the one to copy for a new aggregate's support file:

- `result` / `rejection` (`notes.ts:19-27`) unwrap a handler's `Future<Response, T>` into a plain `Promise`, one for the resolved case and one for the rejected case.
- `newNote` (`notes.ts:29-44`) calls the real `create.handler` and returns the id — the standard way to get a seeded aggregate into a test without hand-building event rows.
- `hydrate` (`notes.ts:46-48`) replays a `MemoryEventDatabase`'s entries through `schemas.hydrate` to get the current aggregate.
- `projectionsHarness` (`notes.ts:61-103`) builds an in-memory `WriteProjections` (a `NotesWriter` plus `RepoProjectionIdempotency`) whose `save` defers through `Future.create`, matching how the real Mongo-backed `save` defers via `Future.attemptP` — a harness whose `save` runs eagerly would hide bugs a real projection wouldn't.
- `delivery` (`notes.ts:105-119`) wraps a projection controller's `handler` in `withIdempotency`, exactly as `handleProjection` does in production, so a projection test sees real duplicate-delivery behavior.

### Test an auth guard directly

An `AuthGuard` is a pure function of `AuthContext`, so call it directly instead of routing a request through it.

```ts
// packages/backend/tests/unit/app/auth-policy.test.ts:31-41
test("Auth.authenticated denies an anonymous caller and allows a signed-in one", () => {
  const guard = Auth.authenticated()

  const denied = guard(anonymous)
  assert.ok(denied.result === "deny")
  assert.equal(denied.status, 401)

  const allowed = guard(user())
  assert.ok(allowed.result === "allow")
  assert.equal(allowed.actor.type, "User")
})
```

`packages/backend/tests/unit/app/auth-policy.test.ts` also covers `Auth.system`, `Auth.session`, and `Auth.anyOf`, and pins `Auth.system` to its capability catalog with a `// @ts-expect-error` case (`auth-policy.test.ts:103-106`).

### Test a command handler rejection

Call `controller.handler` directly with the memory fixtures and assert on the rejected `Response`.

```ts
// packages/backend/tests/unit/domain/note.test.ts:52-63
test("blank title fails before opening the event store", async () => {
  const db = new MemoryEventDatabase()
  const error = await rejection(
    create.handler({
      payload: { noteId: Id.random<"Note">(), title: " \n ", body: "" },
      withEventStore: db.withEventStore,
      ...asUserCommand(),
    })
  )
  assert.match(JSON.stringify(error), /400/)
  assert.equal(db.entries.length, 0)
})
```

`packages/backend/tests/unit/app/handlers.test.ts` covers the same rejection path one layer up, through the real `handleCommand`/`handleQuery` HTTP adapters (decode failures to 400, a guard denial to 401, a handler rejection's status and body reaching the response verbatim, `Set-Cookie` on a session change).

### Test a projection handler

Build a `projectionsHarness`, deliver an event through it, and assert on the saved document or the idempotency set.

```ts
// packages/backend/tests/regression/notes.test.ts:43-64
test("projection duplicate delivery cannot resurrect a deleted note", async () => {
  const h = projectionsHarness()
  const noteId = new Id<"Note">("duplicate")
  const created = new NoteCreated({ type: NoteCreated.type, aggregateId: noteId, title: "Hello", body: "" })
  const deleted = new NoteDeleted({ type: NoteDeleted.type, aggregateId: noteId })
  await delivery(h, created, info(noteId, 0)).promise((e) => new Error(JSON.stringify(e)))
  await delivery(h, deleted, info(noteId, 1)).promise((e) => new Error(JSON.stringify(e)))
  await delivery(h, created, info(noteId, 0)).promise((e) => new Error(JSON.stringify(e)))
  assert.equal(h.docs.get(noteId.value)?.status === "Deleted", true)
  assert.equal(h.seen.size, 2)
  // ...
})
```

A predecessor gap (updating before the create has been projected) rejects with `ErrorMustRetry` and leaves the idempotency set untouched — see the same file's `"projection predecessor failure is retryable and is not marked as delivered"` case.

### Test a reaction with a recording mailer

Once the reaction pipeline exists (`consumers.md`), test a reaction's handler directly. Pass only the services it should call: a `Mailer` that records what it was asked to send, and a fresh `MemoryEventDatabase().withEventStore`. Then assert both the effect and the marker. A missing dependency should fail the test loudly, not be stubbed away. The marker is a transformation of an existing aggregate, so seed that aggregate first through its real command (as `newNote` does, `packages/backend/tests/support/notes.ts:29-44`); an empty database makes the marker emit fail. Build `eventInfo` with an `info(...)` helper like `packages/backend/tests/support/notes.ts:50`, typed for your aggregate's id.

```ts
const db = new MemoryEventDatabase()
const aggregateId = await new<Aggregate>(db) // seed the aggregate the marker transforms, like newNote
const event = new <TriggerEvent>({ type: <TriggerEvent>.type, aggregateId /* , ... */ })
const eventInfo = info(aggregateId, 0)

const sent: Mail[] = []
const mailer: Mailer = { send: (mail) => Future.create((_, resolve) => (sent.push(mail), resolve(undefined), () => {})) }

await <reaction>.controller
  .handler({ event, info: eventInfo, mailer, withEventStore: db.withEventStore })
  .promise((e) => new Error(JSON.stringify(e)))

assert.equal(sent.length, 1)
assert.equal(db.entries.at(-1)?.event_name, "<Marker>")
```

Also cover the failure path. A mailer that rejects must yield `ErrorMustRetry` and leave no marker, so the redelivery sends again. `rejection` (`packages/backend/tests/support/notes.ts:23-27`) is generic over the error type:

```ts
const before = db.entries.length
const failing: Mailer = { send: () => Future.reject(new Error("smtp down")) }
const error = await rejection(
  <reaction>.controller.handler({ event, info: eventInfo, mailer: failing, withEventStore: db.withEventStore })
)
assert.ok(error instanceof ErrorMustRetry)
assert.equal(db.entries.length, before) // the seeded aggregate stays; no marker is appended
```

Build the `Mailer` stub with `Future.create`, not `Future.resolve`, so the send defers like the real `Future.attemptP`-backed mailer (the same reason `projectionsHarness` defers its `save`). For duplicate-delivery behavior, wrap the handler in `withIdempotency` the way `delivery` does for projections (`packages/backend/tests/support/notes.ts:105-119`), keyed on the reaction's endpoint path.

### Meet the coverage gate

`pnpm test:coverage` (part of `pnpm quality`) gates coverage on the file set in `packages/backend/tests/quality/sources.mjs`, not the whole `src/` tree:

```js
// packages/backend/tests/quality/sources.mjs
export const criticalSources = [
  "src/domain/note/**/*.ts",
  "src/domain/{auth,user,workspace}/**/*.ts",
  "src/app/auth/**/*.ts",
  "src/app/{handleCommand,handleQuery,handleProjection,idempotency,responses,engine,resolveAuth,session}.ts",
  "src/lib/event-delivery.ts",
  "src/lib/event-sourcing/**/*.ts",
  "src/lib/google-oidc.ts",
  "src/lib/google.ts",
  "src/lib/postgres.ts",
]

export const thresholds = { lines: 80, statements: 80, functions: 80, branches: 70 }
```

A change to a file matched by `criticalSources` needs unit-test coverage to that bar (`packages/backend/CLAUDE.md` Tests section); lines, statements, and functions must each reach 80%, branches 70%. `test:coverage:all` runs the same suite against every source file, informationally, with no gate.

### Add a regression test for a bug fix

Follow `packages/backend/tests/README.md`'s "Add a regression when fixing a bug" procedure: reproduce the failure under `tests/regression/` before applying the fix, keep the fixture isolated, share reusable setup through `tests/support/`, then run `pnpm test:regression` and `pnpm quality`.

### CI

`.github/workflows/server-ci.yml` runs a `quality` job (`pnpm install --frozen-lockfile --filter @job-kit/backend...` at the repo root, then `pnpm quality`, `pnpm quality:report` in `packages/backend/`) on every PR and push touching `packages/backend/**`, `packages/lib/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, or `.node-version`. `mutation`, `coverage-all`, and `docker-tests` only run on the nightly schedule or `workflow_dispatch`, and each `needs: quality`. `docker-tests` runs in an isolated Compose project (`server-ci-<run id>-<attempt>`), recreates the stack once before testing to check container-recreation, runs `pnpm test:integration` inside the `api` container, then tears the project down with `--volumes`. Every job uploads `packages/backend/reports/**` as a build artifact even on failure.

### Test quality gates

```md
- [ ] Uses `describe`/`test` from `vitest` and asserts with `node:assert/strict`.
- [ ] Uses the memory fixtures (`MemoryEventDatabase`, `MemorySessionStore`, `MemoryLoginCodes`) instead of a real database.
- [ ] A command/query test spreads `asUser` or `asUserCommand()` rather than hand-building `auth`.
- [ ] An `AuthGuard` test calls the guard directly as a function of `AuthContext`.
- [ ] A projection test goes through `withIdempotency` (via a `delivery`-style helper), not the bare handler.
- [ ] A reaction test passes only the services the handler should call, asserts the effect and the marker, and covers a failing service (`ErrorMustRetry`, no marker).
- [ ] New coverage for a file matched by `tests/quality/sources.mjs` meets 80/80/80/70.
- [ ] A bugfix ships with a regression test under `tests/regression/` that fails before the fix.
```
