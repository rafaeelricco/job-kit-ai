# Services

Wrappers around external integrations: Postgres (event store, sessions, login codes), MongoDB (projections), SMTP (mailer), Google OIDC, and a dev-only proxy to the engine operator. All are built once at startup by `configureDependencies()` and handed to every request as `Dependencies`. Env vars: `packages/backend/src/app/environment.ts`. Wiring: `packages/backend/src/app/integrations.ts`.

### `env` fails fast, not per-request

`envDecoder` (`packages/backend/src/app/environment.ts:9-41`) decodes `process.env` once, at import time; every entry has a development-friendly `optionalDefault` so a local run needs no `.env` file at all.

```ts
// packages/backend/src/app/environment.ts:43-49
const environment = D.decode(process.env, envDecoder).unwrap((err) => `Unable to parse environment variables:\n${err}`)
export default environment
```

An invalid or missing variable throws while the module loads — the process never starts serving requests with a bad environment, instead of failing deep inside a request. `packages/backend/development/.env.example` documents the variables a developer sets locally. In development, what reaches the container is the `api.environment` block of `packages/backend/development/compose.yaml` (values dev and production share) plus `compose.dev.yaml` (local defaults: literals, or `${VAR:-default}` for the ones `development/.env` can override). `packages/backend/development/compose.ci.yaml`, layered on the dev overlay, only resets `api.ports` to `[]`, since CI runs `test:integration` with `docker compose exec` inside the container and doesn't need the host port published.

### Env vars

| Variable                                            | Dev default                   | Where read                                                                                             | Required in production                    |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `NODE_ENV`                                          | `development`                 | gates prod-only checks in `mailer.ts`, `loginCodes.ts`, `session.ts`                                   | set directly to `production`              |
| `PORT`                                              | `8080`                        | `index.ts` (`app.listen`)                                                                              | no                                        |
| `EVENT_STORE_USER`                                  | `notepad`                     | `integrations.ts` (`postgresFromEnv`)                                                                  | no                                        |
| `EVENT_STORE_PASSWORD`                              | `notepad`                     | `integrations.ts` (`postgresFromEnv`)                                                                  | yes (`:?`)                                |
| `EVENT_STORE_HOST`                                  | `postgres`                    | `integrations.ts` (`postgresFromEnv`)                                                                  | no                                        |
| `EVENT_STORE_PORT`                                  | `5432`                        | `integrations.ts` (`postgresFromEnv`)                                                                  | no                                        |
| `EVENT_STORE_DATABASE`                              | `notepad_events`              | `integrations.ts` (`postgresFromEnv`)                                                                  | no                                        |
| `EVENT_STORE_CREATE_TABLE_WITH_NAME`                | `event_store`                 | `integrations.ts` (`initializeEventStore`, `withEventStore`)                                           | no                                        |
| `EVENT_STORE_CREATE_REPLICATION_USER_WITH_USERNAME` | `notepad_replication`         | `integrations.ts` (`initializeEventStore`)                                                             | no                                        |
| `EVENT_STORE_CREATE_REPLICATION_USER_WITH_PASSWORD` | `local_notepad_replication`   | `integrations.ts` (`initializeEventStore`)                                                             | no                                        |
| `EVENT_STORE_CREATE_REPLICATION_PUBLICATION`        | `notepad_publication`         | `integrations.ts` (`initializeEventStore`)                                                             | no                                        |
| `MONGODB_PROJECTION_USER`                           | `notepad`                     | `integrations.ts` (`mongoFromEnv`)                                                                     | no                                        |
| `MONGODB_PROJECTION_PASSWORD`                       | `local_notepad_mongo`         | `integrations.ts` (`mongoFromEnv`)                                                                     | yes (`:?`)                                |
| `MONGODB_PROJECTION_HOST`                           | `mongo`                       | `integrations.ts` (`mongoFromEnv`)                                                                     | no                                        |
| `MONGODB_PROJECTION_PORT`                           | `27017`                       | `integrations.ts` (`mongoFromEnv`)                                                                     | no                                        |
| `MONGODB_PROJECTION_DATABASE`                       | `notepad_projections`         | `integrations.ts` (`mongoFromEnv`)                                                                     | no                                        |
| `MONGODB_PROJECTION_REPLICA_SET`                    | `rs0`                         | `integrations.ts` (`mongoFromEnv`)                                                                     | no                                        |
| `MONGODB_PROJECTION_AUTH_DB`                        | `admin`                       | `integrations.ts` (`mongoFromEnv`)                                                                     | no                                        |
| `EVENT_BUS_USERNAME`                                | `notepad_event_bus`           | `lib/event-delivery.ts` (`EventBusAuthMiddleware`)                                                     | no                                        |
| `EVENT_BUS_PASSWORD`                                | `local_notepad_event_bus`     | `lib/event-delivery.ts` (`EventBusAuthMiddleware`)                                                     | no                                        |
| `ENGINE_OPERATOR_URL`                               | `http://postie:8081`          | `engine.ts` (`createEngineProxy`)                                                                      | no                                        |
| `ENGINE_OPERATOR_TOKEN`                             | `change-me`                   | `engine.ts` (`createEngineProxy`); shared with postie's `POSTIE_OPERATOR_TOKEN`                        | yes (`:?`)                                |
| `APP_URL`                                           | `http://localhost:5173/jobs/` | `integrations.ts` (Google redirect URI), `index.ts` (`mountGoogleSignIn` passes it to `lib/google.ts`) | set directly to `https://r1cco.com/jobs/` |
| `GOOGLE_CLIENT_ID`                                  | `""`                          | `integrations.ts` (`googleOidc`)                                                                       | no (empty disables Google sign-in)        |
| `GOOGLE_CLIENT_SECRET`                              | `""`                          | `integrations.ts` (`googleOidc`)                                                                       | no                                        |
| `SMTP_URL`                                          | `""`                          | `mailer.ts` (`mailerFromEnv`)                                                                          | yes (`:?`)                                |
| `MAIL_FROM`                                         | `Job Kit <login@localhost>`   | `mailer.ts` (`mailerFromEnv`)                                                                          | no                                        |
| `LOGIN_CODE_SECRET`                                 | `""`                          | `loginCodes.ts` (`loginCodeSecretFromEnv`)                                                             | yes (`:?`)                                |

"Required in production" reflects `packages/backend/development/compose.prod.yaml`: five variables use `${VAR:?set in /etc/job-kit/api.env}` and fail the deploy if unset; `NODE_ENV` and `APP_URL` are set directly to production values in that same file; everything else keeps its `compose.yaml` value.

### `configureDependencies()` builds everything once

```ts
// packages/backend/src/app/integrations.ts:30-40
export type Dependencies = {
  postgres: Postgres
  mongo: Mongo
  withEventStore: WithEventStore
  withProjectionReader: WithProjectionReader
  withProjectionWriter: WithProjectionWriter
  repositories: Repositories
  sessions: SessionStore
  loginCodes: LoginCodes
  google: GoogleOidc
}
```

`configureDependencies(): Future<Error, Dependencies>` (`packages/backend/src/app/integrations.ts:99`) creates the Postgres and Mongo clients, runs their one-time schema setup (the event-store table and replication publication, `auth_sessions`, `auth_login_codes`, the Mongo projection collections), and returns the `Dependencies` that `src/index.ts` passes into `handleCommand`/`handleQuery`/`handleProjection`. `src/index.ts` forks it once at startup:

```ts
// packages/backend/src/index.ts:186
configureDependencies().fork(exitWithError, start)
```

### Mailer

`mailerFromEnv()` (`packages/backend/src/app/mailer.ts:11-22`): `SMTP_URL === ""` logs to stdout in development and throws `SMTP_URL is required in production` when `NODE_ENV === "production"`; otherwise it wraps `nodemailer.createTransport(env.SMTP_URL)` and sends with `from: env.MAIL_FROM`.

```ts
// packages/backend/src/app/mailer.ts:11-22
function mailerFromEnv(): Mailer {
  if (env.SMTP_URL === "") {
    if (env.NODE_ENV === "production") throw new Error("SMTP_URL is required in production")
    return {
      send: (mail) => Future.attemptP(async () => console.log(`[mail] ${mail.to}: ${mail.subject}\n${mail.text}`)),
    }
  }
  const transport = nodemailer.createTransport(env.SMTP_URL)
  return {
    send: (mail) => Future.attemptP(() => transport.sendMail({ from: env.MAIL_FROM, ...mail })).map(() => undefined),
  }
}
```

The only caller today is `loginCodes.send` (`packages/backend/src/app/loginCodes.ts`), fired outside the event-store transaction (see below). A reaction that mails is the second caller, so the first one moves `mailerFromEnv()` into `Dependencies.mailer` and passes that one instance to both (`consumers.md`, "Build the reaction pipeline").

### Postgres and Mongo: transactions that always clean up

`Postgres` (`packages/backend/src/lib/postgres.ts`) wraps a `pg` `Pool`; `Mongo` (`packages/backend/src/lib/mongo.ts`) wraps a `MongoClient`. `Postgres.withTransaction(options, onConnectionError, f)` takes an isolation option and runs on `withConnection`, which acquires and releases the pooled client with `Future.bracket`. `Mongo.withTransaction(onError, f)` commits or aborts with `bichain` and always ends the session in `.finally`. Both clean up on success, failure, and cancellation:

```ts
// packages/backend/src/lib/postgres.ts:371-379
withConnection<E, T>(onConnectionError: (e: Error) => E, f: (c: Connection) => Future<E, T>): Future<E, T> {
  const acquire = Future.attemptP(() => this.pool.connect())
    .mapRej(onConnectionError)
    .map((client) => new Connection(client))
  const release = (conn: Connection) => Future.attemptP(() => conn.release()).mapRej(onConnectionError)
  return Future.bracket(acquire, release, f)
}
```

`withTransaction` layers commit/rollback on top of `withConnection`; `PostgresTransaction` sends `BEGIN` lazily on the first query, so an unused transaction costs no round trip. Release and cleanup code logs rather than throws, since a throw there would mask the error that triggered cleanup (`packages/backend/CLAUDE.md`).

`configureDependencies` uses one Mongo transaction runner as both `WithProjectionReader` and `WithProjectionWriter` — a callback typed to accept a reader also accepts the writer it's actually given, since `MongoProjectionStore` satisfies both.

### Google OIDC wiring

`googleOidc()` (`packages/backend/src/lib/google-oidc.ts`) is constructed once in `configureDependencies`, from `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, with the redirect URI derived from `APP_URL`:

```ts
// packages/backend/src/app/integrations.ts:120-124
google: googleOidc({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  redirectUri: new URL(GOOGLE_CALLBACK_PATH, env.APP_URL).href,
}),
```

`configured` is `false` when either is empty, and the sign-in flow (`packages/backend/src/lib/google.ts`) reports `unavailable` rather than attempting a request. Full flow: `auth.md`.

### Dev engine proxy: `/api/dev/engine`

`createEngineProxy()` (`packages/backend/src/app/engine.ts`) is mounted ahead of both the projection endpoint and `mountApi`, unauthenticated, proxying a fixed route allowlist to `ENGINE_OPERATOR_URL` with a bearer `ENGINE_OPERATOR_TOKEN` and a 35s timeout (`OPERATOR_TIMEOUT_MS`). It never reaches the event store or projections — it's a thin, timeout-guarded forward to the postie operator. In production nginx refuses `/api/dev/`, so the route stays reachable only on loopback (`packages/backend/development/compose.prod.yaml` header comment).

### Side effects stay outside `withEventStore`

An event-store transaction can roll back Postgres events; it cannot roll back an already-sent email. `verifyCode.ts` keeps `loginCodes.consume` and `session.start` — the two side effects of signing in — outside the `withEventStore` generator entirely:

```ts
// packages/backend/src/domain/auth/command/verifyCode.ts:16-31
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

`loginCodes.consume` runs its own Postgres transaction before `withEventStore` opens one; `session.start` runs its own transaction after `withEventStore`'s has committed. The event-store generator (`provisionUser`) only ever emits events — it never mails, and it never touches the session store.

### Add an env var

- [ ] Add it to `envDecoder` in `packages/backend/src/app/environment.ts` with a dev-safe `optionalDefault`.
- [ ] Add it to `packages/backend/development/.env.example` if a developer is expected to set it, and to an `api.environment` block: `packages/backend/development/compose.yaml` when dev and production share the value, otherwise `compose.dev.yaml` for the local default (a literal, or `${VAR:-default}` if `development/.env` should override it).
- [ ] Add it to `packages/backend/development/compose.prod.yaml` as `${VAR:?set in /etc/job-kit/api.env}` if production must set it; put the real value in `/etc/job-kit/api.env` on the VPS (`packages/backend/README.md` Production section).
- [ ] Read it through `env`, not `process.env`, everywhere else.

### Service quality gates

- [ ] New env vars are added to `envDecoder`, not read from `process.env` directly.
- [ ] A service is built once in `configureDependencies` and passed through `Dependencies`, not constructed per request.
- [ ] Mail, session, and login-code side effects run outside the `withEventStore` generator (`verifyCode.ts`).
- [ ] A reaction gets its services as handler arguments from `Dependencies` (`mailer` joins `Dependencies` with the first reaction; see `consumers.md`), never a nullable registry or a per-call `mailerFromEnv()`.
- [ ] Postgres/Mongo access goes through `withTransaction`/`withConnection`, never a raw pooled client.
- [ ] `/api/dev/engine` gains no new route without updating the fixed `ROUTES` allowlist in `engine.ts`.
