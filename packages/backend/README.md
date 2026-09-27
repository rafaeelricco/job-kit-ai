# Event Sourcing Scaffold

A tiny notes app that teaches event sourcing. You save a note, the app writes
down _what happened_ (an event) in PostgreSQL, and a second process turns those
events into a list you can read from MongoDB.

```text
you → command → PostgreSQL (events) → postie → MongoDB (notes) → query → you
```

## What you need

- [Node.js 22](https://nodejs.org)
- [pnpm](https://pnpm.io) 10 — `npm install -g pnpm`
- [Docker](https://www.docker.com/products/docker-desktop/), open and running

## Start it

```bash
pnpm install
```

```bash
pnpm run up
```

The first start takes a few minutes. When it finishes, open
**http://localhost:3010** — that is the API. Create a note with the curl
examples below, then list it to confirm the projection caught up.

Is it alive?

```bash
curl --fail http://localhost:3010/docker_healthcheck
```

## Set up sign-in

Sign-in works with an email code or a Google account. Both read their
settings from `development/.env`. Start from the example:

```bash
cp development/.env.example development/.env
```

| Variable                                   | What it does                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `SMTP_URL`, `MAIL_FROM`                    | Where login codes are sent. With `SMTP_URL` empty, the code is printed in the API log instead. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google OAuth client. Leave either empty and the Google button reports it is not set up.    |
| `APP_URL`                                  | Where the app runs. Google sends people back to this address.                                  |
| `LOGIN_CODE_SECRET`                        | Key for hashing stored login codes. Empty uses a development key; production requires one.     |

To see a login code when `SMTP_URL` is empty:

```bash
pnpm compose logs -f api | grep -A3 '\[mail\]'
```

To turn on Google sign-in:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Add this **Authorized redirect URI**. It is the origin of `APP_URL` plus the
   callback path, so change it if you change `APP_URL`:
   `http://localhost:5173/api/v1/auth/google/callback`
3. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` in `development/.env`.
4. Run `pnpm run up` again so the API picks up the new values.

## Stop it

```bash
pnpm run down
```

Your notes are kept. They are there again next time you start.

## Change the code

1. Start the app (`pnpm run up`).
2. Edit any file in `src/`.
3. Save. The app restarts by itself in about a second.

Run `pnpm run up` again only if you changed `package.json`, a test file, or
anything in the shared `../lib/` (it is not mounted into the container).

Where things are:

| Folder             | What is inside                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/domain/note/` | The notes: commands (create, update, delete), queries (get, list), events, and the projection. **Start here.** |
| `src/app/`         | The glue that connects notes to the web server and the databases.                                              |
| `src/lib/`         | Server building blocks: the event store, Postgres, Mongo, the router. Import them as `@be/lib/...`.            |
| `../lib/`          | Shared with the app: `Maybe`, `Result`, `Future`, schemas, time. Import them as `@lib/...`.                     |
| `tests/`           | The tests.                                                                                                      |

Before you write code, read [CONVENTIONS.md](CONVENTIONS.md). The short
version: no `null`, no `throw` for things that can normally go wrong, no `any`.
Use `Maybe` for "might not exist", `Result` for "might fail", and `Future` for
"takes time".

## Test it

Run the fast quality gates without Docker:

```bash
pnpm quality
```

This runs lint, TypeScript checks, the production build, the critical-source unit
and regression suite with coverage. For the exact test
procedures and report locations, see [tests/README.md](tests/README.md).

The nightly and manually started CI run also measures mutation score, all-source
coverage, and Docker-backed integration tests. All-source
coverage is informational. Critical coverage gates are 80% lines, statements,
and functions, and 70% branches.

## Call the API

Everything is a `POST` with JSON. Notes need a signed-in session; curl keeps
the session cookie in `cookies.txt`.

Sign in with an email code. There is no separate sign-up: the first sign-in
creates your account. Ask for a code:

```bash
curl -sS http://localhost:3010/api/v1/auth/command/request-code \
  -H 'Content-Type: application/json' -d '{"email":"me@example.com"}'
```

With `SMTP_URL` empty, the six-digit code is printed in the API log (see
[Set up sign-in](#set-up-sign-in)):

```bash
pnpm compose logs -f api | grep -A3 '\[mail\]'
```

Trade the code for a session. It works once and expires in 10 minutes:

```bash
curl -sS -c cookies.txt http://localhost:3010/api/v1/auth/command/verify-code \
  -H 'Content-Type: application/json' -d '{"email":"me@example.com","code":"123456"}'
```

Create a note:

```bash
NOTE_ID=$(node -pe 'crypto.randomUUID()')
curl -sS -b cookies.txt http://localhost:3010/api/v1/note/command/create-note \
  -H 'Content-Type: application/json' \
  -d "{\"noteId\":\"$NOTE_ID\",\"title\":\"Shopping\",\"body\":\"Milk\"}"
```

You choose the `noteId`, so sending the same request again is safe: it answers
with the same `noteId` and records nothing new. Use that id below in place of
`YOUR_NOTE_ID`.

List notes:

```bash
curl -sS -b cookies.txt http://localhost:3010/api/v1/note/query/list-notes \
  -H 'Content-Type: application/json' -d '{}'
```

Read one note:

```bash
curl -sS -b cookies.txt http://localhost:3010/api/v1/note/query/get-note \
  -H 'Content-Type: application/json' -d '{"noteId":"YOUR_NOTE_ID"}'
```

Change a note (send both title and body):

```bash
curl -sS -b cookies.txt http://localhost:3010/api/v1/note/command/update-note \
  -H 'Content-Type: application/json' \
  -d '{"noteId":"YOUR_NOTE_ID","title":"Weekend shopping","body":"Milk and coffee"}'
```

Delete a note:

```bash
curl -sS -b cookies.txt http://localhost:3010/api/v1/note/command/delete-note \
  -H 'Content-Type: application/json' -d '{"noteId":"YOUR_NOTE_ID"}'
```

A new note can take a second to show up in the list. That is normal: the
event is saved first, and the list is updated right after.

Sign out:

```bash
curl -sS -b cookies.txt -c cookies.txt http://localhost:3010/api/v1/auth/command/sign-out \
  -H 'Content-Type: application/json' -d '{}'
```

## Look inside the databases

Every event ever saved:

```bash
pnpm compose exec postgres \
  psql -U notepad -d notepad_events -c \
  'SELECT id, event_name, aggregate_version, payload FROM event_store ORDER BY id;'
```

The notes as the list sees them:

```bash
pnpm compose exec mongo \
  mongosh --quiet --username notepad --password local_notepad_mongo \
  --authenticationDatabase admin notepad_projections \
  --eval 'db.Note_Notes.find().forEach(printjson)'
```

## When something goes wrong

See what the app is saying:

```bash
pnpm compose logs --tail=100 api postie
```

| Problem                          | Fix                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm run up` fails right away   | Docker is not running. Open Docker and try again.                                                       |
| It fails while pulling `postie`  | Docker cannot reach `ghcr.io/rafaeelricco/postie`. Check your connection, then run `pnpm run up` again. |
| Port 3010 is already used        | Set `API_PORT` in `development/.env` to another number.                                                 |
| A note never appears in the list | Check postie logs and that the subscription is not paused (`GET /api/dev/engine/subscriptions`).        |

## Recover a missing Kafka topic

Kafka stores its logs in the named volume at `/var/lib/kafka/data`.
Keep that volume when recreating containers.

If Postie reports `established topic is missing`, rebuilding the API will not
repair the blocked generation. Stop the whole stack with `pnpm run down` first,
without removing volumes. With PostgreSQL events and MongoDB projections
and idempotency records retained, select a previously unused positive
`POSTIE_GENERATION` in `development/.env`, then run `pnpm run up`.
For example, use `POSTIE_GENERATION=2` when only generation 1 exists.
Keep that value for subsequent starts.

A new generation snapshots retained events and starts subscriptions as running;
it does not carry over pause or skip decisions. Inspect the old replication
slot after recovery because an inactive slot can retain WAL.

## Learn more

- [CONVENTIONS.md](CONVENTIONS.md) — how code is written here.
- [Quality checks and test procedures](tests/README.md).

## Production

Every push to `main` that touches the server runs
`.github/workflows/deploy-server.yml`. After the quality gate passes, the
self-hosted runner on r1cco.com starts `development/compose.yaml` with the
`development/compose.prod.yaml` overlay as Compose project `job-kit-api`. nginx
proxies `https://r1cco.com/api/` to `127.0.0.1:3010`.

Secrets live on the VPS in `/etc/job-kit/api.env` (root:r1cco-runner, 0640).
The deploy fails fast if `EVENT_STORE_PASSWORD`, `MONGODB_PROJECTION_PASSWORD`,
`ENGINE_OPERATOR_TOKEN`, `SMTP_URL`, or `LOGIN_CODE_SECRET` is missing. The
Postgres and Mongo passwords are fixed once their volumes exist. The Google
redirect URI is `https://r1cco.com/api/v1/auth/google/callback`.

Logs on the VPS:

```bash
docker compose -p job-kit-api logs -f api
```
