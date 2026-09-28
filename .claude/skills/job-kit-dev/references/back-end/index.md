# job-kit-ai server

Event-sourced Express at `packages/backend/`: Postgres event log, MongoDB projections pushed by postie, client-safe `.api.ts` contracts. Reviewer rules live in `packages/backend/CLAUDE.md`; rationale in `packages/backend/CONVENTIONS.md`.

### Route backend work to the right reference

Smallest matching leaf. Load `templates.md` only when adding a new shape.

| Task                                                                                                    | Read            |
| ------------------------------------------------------------------------------------------------------- | --------------- |
| Mental model, naming, handler signatures, registration                                                  | conventions.md  |
| Copy skeletons for new endpoint/event/aggregate/projection/reaction/env var                             | templates.md    |
| New or changed command (persisting a new field also touches the event/aggregate schema — see domain.md) | commands.md     |
| New or changed query                                                                                    | queries.md      |
| New event, aggregate, deterministic-id uniqueness, event-store behavior                                 | domain.md       |
| New projection or reaction                                                                              | consumers.md    |
| Auth guard, capability, session, login code, Google sign-in                                             | auth.md         |
| Env var, integration (Postgres, Mongo, mailer, Google OIDC, engine proxy)                               | services.md     |
| Server tests (unit, regression, integration, coverage gate)                                             | testing.md      |
| Consuming server endpoints from the web app                                                             | client-usage.md |
| Timestamp or duration field / schema / constant                                                         | ../time.md      |

### Clarify backend intake

Ask only for details that affect the output; otherwise choose the local pattern.

- Scope: new endpoint, event, aggregate, projection, reaction, auth guard, env var, review, or refactor.
- Area: existing domain folder under `packages/backend/src/domain/`, or whether this is a new area.
- New endpoint: command or query; auth requirement; emitted events; projections read.
- New event: aggregate, creation vs transformation, past-tense event name.
- New projection: consumed events, document shape, queries that will read it.
- New reaction: trigger events, service called, side effect, marker event, idempotency/replay protection. The first reaction also builds the pipeline (consumers.md).

Then: `conventions.md` (layer map, registration, runtime traps) → the leaf → `templates.md` for a new shape → that leaf's quality gates. From `packages/backend/`: `pnpm quality` (lint, typecheck, build, coverage gate). When an `.api.ts` schema changed, also `pnpm typecheck` in `packages/frontend/`.

### Avoid backend runtime traps

These are the backend failures TypeScript may not catch.

- Register new event classes in `packages/backend/src/app/events.ts` (`new CSchema(...)` / `new TSchema(...)`).
- Wire a new projection in `packages/backend/src/app/projections.ts` (6 places), `mountProjection` in `src/index.ts`, and both `development/postie/application.yaml` + `development/postie/postie.yaml` destinations.
- Add a command/query to `src/api.ts` and to `implementation` in `src/index.ts`; `Implementation<typeof api>` fails the build on a mismatch. Tests that hand-build `impl` or a full projection map (`packages/backend/tests/unit/event-server.test.ts`, `packages/backend/tests/support/aiSetups.ts`) need the new key too; `pnpm typecheck` lists them.
- Projection and reaction routes need their own `express.json({ limit: "5mb" })` mounted before the global parser.
- Wire a reaction with `mountReaction`, an `application.yaml` destination, and `kind: reaction` in `postie.yaml`.
- Add semantic retry safety for reaction side effects when a duplicate external call would matter; per-endpoint idempotency covers only a successful replay.
- Never change a shipped event schema; add a new event type (`EventStoreCorruptionError`).

### Run backend quality gates

- [ ] Event classes registered with `new CSchema(...)` or `new TSchema(...)` in `packages/backend/src/app/events.ts`.
- [ ] New projection wired in all 6 `packages/backend/src/app/projections.ts` places, `mountProjection` in `src/index.ts`, and both event-delivery YAML files.
- [ ] Reactions have the idempotency strategy their side effect needs (marker event, idempotent effect, or deterministic marker id).
- [ ] No `await` inside `function* (store)` — only `yield* store.*`.
- [ ] Auth guard is an `Auth.*` builder; the controller's `Result` generic is set via `GuardResult<typeof authGuard>` whenever it differs from the default.
- [ ] Domain errors are a typed `Result` union, mapped by `toResponse`/`respond`; never `throw`n from inside `withEventStore`.
- [ ] `pnpm quality` passes; `packages/frontend/`'s `pnpm typecheck` passes if a `.api.ts` schema changed.

### Respect backend scope boundaries

In:

- `packages/backend/src/`
- `packages/backend/tests/`
- `packages/backend/development/postie/*.yaml` — event-delivery config (`application.yaml` data_destinations, `postie.yaml` destinations)

Out:

- `packages/frontend/` UI implementation details
- `packages/backend/development/compose.prod.yaml` (production overlay)
- CI, unless explicitly requested
- UI follow-up → `front-end/index.md`
