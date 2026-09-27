import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vitest"
import { Future } from "@lib/future"
import * as s from "@lib/json/schema"
import { api } from "@be/api"
import { Id } from "@be/lib/event-sourcing/event"
import env from "@be/app/environment"
import { POSIX } from "@lib/time"
import { configureDependencies } from "@be/app/integrations"
import { writeProjections, type WriteProjections } from "@be/app/projections"
import { RepoProjectionIdempotency } from "@be/app/idempotency"
import { withIdempotency } from "@be/app/handleProjection"
import { controller as notesProjection, RepoNotes } from "@be/domain/note/projection/notes"
import { NoteCreated } from "@be/domain/note/events/note/noteCreated"
import { ErrorMustRetry, type AmbarResponse } from "@be/lib/event-delivery"
import { type EventInfo } from "@be/lib/event-sourcing/event"
import { createLiveFixture, LiveFixture, withCleanup } from "@tests/support/live"
import { provisionUser } from "@be/domain/auth/provisionUser"
import { User } from "@be/domain/user/aggregate/user"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"

let fixture: LiveFixture | undefined

function live(): LiveFixture {
  assert.ok(fixture, "The live fixture is created by the executing test hook")
  return fixture
}

beforeAll(() => {
  fixture = createLiveFixture()
})

afterAll(async () => {
  if (fixture) await fixture.close()
})

test("HTTP validation rejects invalid payloads, unknown notes, malformed JSON, and oversized bodies", async () =>
  live().runCase("http-validation", async () => {
    const current = live()
    for (const payload of [
      { noteId: "validation", title: " ", body: "" },
      { noteId: "validation", title: 7, body: "" },
      { noteId: "validation", title: "Missing body" },
      { title: "Missing noteId", body: "" },
    ]) {
      const response = await current.post(api.command.note_createNote.path, payload)
      assert.equal(response.status, 400)
      assert.ok((await response.text()).includes("error"))
    }
    const malformed = await current.request(api.command.note_createNote.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    })
    assert.equal(malformed.status, 400)
    const tooLarge = await current.post(api.command.note_createNote.path, {
      title: "Huge",
      body: "x".repeat(110000),
    })
    assert.equal(tooLarge.status, 413)
    const unknown = { noteId: `missing-${current.caseId}` }
    assert.equal((await current.post(api.query.note_query_note.path, unknown)).status, 404)
    assert.equal((await current.post(api.command.note_deleteNote.path, unknown)).status, 404)
    assert.equal(
      (
        await current.post(api.command.note_updateNote.path, {
          ...unknown,
          title: "New",
          body: "",
        })
      ).status,
      404
    )
  }))

test("create retries with the same identifier append exactly one event", async () =>
  live().runCase("create-retry", async () => {
    const current = live()
    const noteId = Id.random<"Note">()
    current.trackNote(noteId)
    const payload = { noteId, title: `${current.caseId}-retry`, body: "" }
    const responses = await Promise.all([
      current.call(api.command.note_createNote, payload),
      current.call(api.command.note_createNote, payload),
    ])
    const retry = await current.call(api.command.note_createNote, payload)
    for (const response of [...responses, retry]) {
      assert.equal(response.noteId.value, noteId.value)
    }
    assert.deepEqual(
      (await current.history(noteId)).map((row) => row.event_name),
      ["NoteCreated"]
    )
  }))

test("projection consumer authenticates before parsing and requests retry on invalid delivery", async () =>
  live().runCase("consumer-auth", async () => {
    const current = live()
    const path = "/api/v1/note/projection/notes"
    const malformed = await current.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    })
    assert.equal(malformed.status, 401, "Consumer must authenticate before parsing")
    const wrongCredentials = Buffer.from("wrong:wrong").toString("base64")
    assert.equal((await current.post(path, {}, { Authorization: `Basic ${wrongCredentials}` })).status, 401)
    const credentials = Buffer.from(`${env.EVENT_BUS_USERNAME}:${env.EVENT_BUS_PASSWORD}`).toString("base64")
    const invalid = await current.post(path, {}, { Authorization: `Basic ${credentials}` })
    assert.equal(invalid.status, 200)
    assert.match(await invalid.text(), /must_retry/)
  }))

test("note endpoints require a session, and a code sign-in/sign-out round-trips through the cookie", async () =>
  live().runCase("auth-session", async () => {
    const current = live()
    const anonymous = { Cookie: "" }
    assert.equal((await current.post(api.query.note_query_notes.path, {}, anonymous)).status, 401)
    assert.equal(
      (await current.post(api.command.note_createNote.path, { noteId: "x", title: "t", body: "" }, anonymous)).status,
      401
    )
    const me = await current.call(api.query.auth_query_whoAmI, {})
    assert.equal(me.actor.type, "User")
    // a second, private session, driven entirely by an emailed code: wrong code, right code, then the same code again
    const email = "user@example.test"
    await current.seedLoginCode(email, "123456")
    assert.equal(
      (await current.post(api.command.auth_verifyCode.path, { email, code: "000000" }, anonymous)).status,
      401
    )
    const verified = await current.post(api.command.auth_verifyCode.path, { email, code: "123456" }, anonymous)
    assert.equal(verified.status, 200)
    const cookie = { Cookie: verified.headers.get("set-cookie")?.split(";")[0] ?? "" }
    assert.equal(
      (await current.post(api.command.auth_verifyCode.path, { email, code: "123456" }, anonymous)).status,
      401
    )
    assert.equal((await current.post(api.query.note_query_notes.path, {}, cookie)).status, 200)
    assert.equal((await current.post(api.command.auth_signOut.path, {}, cookie)).status, 200)
    assert.deepEqual(await (await current.post(api.query.auth_query_whoAmI.path, {}, cookie)).json(), {
      actor: { type: "Anonymous" },
    })
    assert.equal((await current.post(api.query.note_query_notes.path, {}, cookie)).status, 401)
    // any well-formed address gets a code; there is no allowlist
    const other = `other-${current.caseId}@example.test`
    assert.equal((await current.post(api.command.auth_requestCode.path, { email: other }, anonymous)).status, 200)
    assert.equal(await current.countLoginCodes(other), 1)
  }))

test("login codes: resend waits out the cooldown, five misses lock until expiry, and an expired code fails", async () =>
  live().runCase("login-code-limits", async () => {
    const current = live()
    const anonymous = { Cookie: "" }
    const email = "user@example.test"
    const request = () => current.post(api.command.auth_requestCode.path, { email }, anonymous)
    const verify = async (code: string) =>
      (await current.post(api.command.auth_verifyCode.path, { email, code }, anonymous)).status

    await current.seedLoginCode(email, "123456")
    const seeded = await current.loginCode(email)
    assert.equal((await request()).status, 200)
    assert.deepEqual(await current.loginCode(email), seeded, "a resend inside the cooldown must not replace the code")

    for (let miss = 0; miss < 5; miss++) assert.equal(await verify("000000"), 401)
    assert.equal(await verify("123456"), 401, "the right code must fail once the address is locked")
    await current.ageLoginCode(email, { expired: false })
    assert.equal((await request()).status, 200)
    assert.deepEqual(await current.loginCode(email), { ...seeded, attempts: 5 }, "no new code while locked and live")

    await current.ageLoginCode(email, { expired: true })
    assert.equal((await request()).status, 200)
    const fresh = await current.loginCode(email)
    assert.notEqual(fresh?.codeHash, seeded?.codeHash, "an expired lock gets a fresh code")
    assert.equal(fresh?.attempts, 0)

    const stale = "stale@example.test"
    await current.seedLoginCode(stale, "654321")
    await current.ageLoginCode(stale, { expired: true })
    await current.ageLoginCode(email, { expired: false })
    assert.equal((await request()).status, 200)
    assert.equal(await current.countLoginCodes(stale), 0, "issuing a code sweeps other addresses' expired codes")

    await current.seedLoginCode(email, "654321")
    await current.ageLoginCode(email, { expired: true })
    assert.equal(await verify("654321"), 401, "an expired code must fail")
  }))

test("CRUD, projection delivery, event history, and duplicate delivery remain consistent", async () =>
  live().runCase("crud-and-delivery", async () => {
    const current = live()
    const marker = current.caseId
    const noteId = await current.createNote(`  ${marker}  `, "  text\n")
    const initial = await current.eventually(
      () => current.activeNote(noteId),
      (note) => note !== undefined
    )
    assert.ok(initial)
    assert.equal(initial.title, marker)
    assert.equal(initial.body, "  text\n")
    const { note } = await current.call(api.query.note_query_note, { noteId })
    assert.equal(note.noteId.value, noteId.value)
    const rows = await current.history(noteId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.event_name, "NoteCreated")
    assert.equal(Number(rows[0]?.aggregate_version), 0)

    await current.call(api.command.note_updateNote, {
      noteId,
      title: `${marker}-edited`,
      body: "",
    })
    const updated = await current.eventually(
      () => current.activeNote(noteId),
      (value) => value?.title === `${marker}-edited`
    )
    assert.ok(updated)
    assert.equal(updated.body, "")
    assert.equal(updated.createdAt.value, initial.createdAt.value)
    await current.call(api.command.note_updateNote, {
      noteId,
      title: ` ${marker}-edited `,
      body: "",
    })
    assert.equal((await current.history(noteId)).length, 2, "Same-value update must not append")
    assert.ok(rows[0])
    await Promise.all([current.deliver(rows[0]), current.deliver(rows[0])])
    const queried = await current.call(api.query.note_query_note, { noteId })
    assert.equal(queried.note.title, `${marker}-edited`)
    assert.equal(queried.note.body, "")

    await current.call(api.command.note_deleteNote, { noteId })
    await current.call(api.command.note_deleteNote, { noteId })
    await current.eventually(
      () => current.activeNote(noteId),
      (value) => value === undefined
    )
    await current.deliver(rows[0])
    assert.equal((await current.post(api.query.note_query_note.path, { noteId: noteId.value })).status, 404)
    assert.equal(
      (
        await current.post(api.command.note_updateNote.path, {
          noteId: noteId.value,
          title: "Restore",
          body: "",
        })
      ).status,
      404
    )
    assert.deepEqual(
      (await current.history(noteId)).map((row) => row.event_name),
      ["NoteCreated", "NoteUpdated", "NoteDeleted"]
    )
  }))

test("duplicate creation delivery cannot restore a note deleted without an update", async () =>
  live().runCase("deleted-note-redelivery", async () => {
    const current = live()
    const noteId = await current.createNote(`${current.caseId}-deleted`, "original event")
    const [created] = await current.history(noteId)
    assert.ok(created)
    await current.eventually(
      () => current.activeNote(noteId),
      (note) => note !== undefined
    )
    await current.call(api.command.note_deleteNote, { noteId })
    await current.eventually(
      () => current.activeNote(noteId),
      (note) => note === undefined
    )
    await current.deliver(created)
    await current.deliver(created)
    assert.equal(await current.activeNote(noteId), undefined)
    assert.equal((await current.post(api.query.note_query_note.path, { noteId: noteId.value })).status, 404)
    assert.deepEqual(
      (await current.history(noteId)).map((row) => row.event_name),
      ["NoteCreated", "NoteDeleted"]
    )
  }))

test("concurrent updates preserve history versions and list ordering follows update time", async () =>
  live().runCase("concurrency-and-sort", async () => {
    const current = live()
    const noteId = await current.createNote(`${current.caseId}-concurrent`, "")
    await Promise.all([
      current.call(api.command.note_updateNote, {
        noteId,
        title: `${current.caseId}-A`,
        body: "A",
      }),
      current.call(api.command.note_updateNote, {
        noteId,
        title: `${current.caseId}-B`,
        body: "B",
      }),
    ])
    const rows = await current.history(noteId)
    assert.deepEqual(
      rows.map((row) => Number(row.aggregate_version)),
      [0, 1, 2]
    )
    const last = rows[2]
    assert.ok(last)
    const payload = s
      .decode(s.object({ title: s.string, body: s.string }), JSON.parse(last.payload))
      .unwrap((message) => message)
    const projected = await current.eventually(
      () => current.activeNote(noteId),
      (note) => note?.title === payload.title
    )
    assert.equal(projected?.body, payload.body)
    const queried = await current.call(api.query.note_query_note, { noteId })
    assert.equal(queried.note.title, payload.title)
    assert.equal(queried.note.body, payload.body)
    const { notes } = await current.call(api.query.note_query_notes, {})
    const actual = notes.map((note) => note.noteId.value)
    const expected = [...notes]
      .sort((a, b) => b.updatedAt.value - a.updatedAt.value || a.noteId.value.localeCompare(b.noteId.value))
      .map((note) => note.noteId.value)
    assert.deepEqual(actual, expected)
  }))

test("projection mutations roll back when saving the idempotency marker fails", async () =>
  live().runCase("projection-rollback", async () => {
    const dependencies = await configureDependencies().promise((error) => error)
    await withCleanup(
      async () => {
        const noteId = new Id<"Note">(`rollback-${live().caseId}`)
        const info: EventInfo = {
          event_id: new Id(`event-${noteId.value}`),
          aggregate_id: noteId,
          aggregate_version: 0,
          correlation_id: new Id(`event-${noteId.value}`),
          causation_id: new Id(`event-${noteId.value}`),
          recorded_on: POSIX.now(),
        }
        const projected = {
          eventId: info.event_id,
          projection: "/api/v1/note/projection/notes",
        }
        const onError = (error: Error): AmbarResponse => new ErrorMustRetry(error.message)
        const attempt = dependencies.withProjectionWriter(onError, (store) => {
          const real = writeProjections(dependencies.repositories, store)
          const projections: WriteProjections = {
            ...real,
            [RepoProjectionIdempotency.collectionName]: {
              ...real[RepoProjectionIdempotency.collectionName],
              save: () =>
                Future.reject({
                  type: "driver",
                  error: new Error("Injected deduplication save failure"),
                }),
            },
          }
          return withIdempotency(
            projections,
            projected,
            notesProjection.handler({
              event: new NoteCreated({
                type: NoteCreated.type,
                aggregateId: noteId,
                title: "Rollback",
                body: "",
              }),
              info,
              projections,
            })
          )
        })
        const failure = await new Promise<AmbarResponse>((resolve, reject) => {
          attempt.fork(resolve, () => reject(new Error("Expected the injected projection failure")))
        })
        assert.ok(failure instanceof ErrorMustRetry)
        assert.match(failure.description, /Injected deduplication save failure/)
        await dependencies.mongo.withTransactionP(async (transaction) => {
          const notes = await transaction.find<{ _id: string }>(RepoNotes.collectionName, { _id: noteId.value })
          const markers = await transaction.find(RepoProjectionIdempotency.collectionName, {
            eventId: info.event_id.value,
          })
          assert.equal(notes.length, 0, "Note mutation must roll back with dedup failure")
          assert.equal(markers.length, 0, "Failed delivery must remain retryable")
        })
      },
      [() => dependencies.postgres.disconnect(), () => dependencies.mongo.disconnect()],
      "Projection rollback check and datastore disconnect failed"
    )
  }))

test("engine pause and resume control delivery and correlate the event log", async () =>
  live().runCase("engine-operator-and-delivery", async () => {
    const current = live()
    const ready = await current.eventually(
      async () => (await current.engineRequest("/api/dev/engine/status")).body,
      (value) =>
        typeof value === "object" &&
        value !== null &&
        ["ready", "degraded"].includes((value as { status?: string }).status ?? "")
    )
    assert.ok(ready)
    const subscriptions = await current.engineSubscriptions()
    const subscription = subscriptions.find((item) => item.id === "Note_Projection_Notes")
    assert.ok(subscription, "Note projection subscription must be exposed by the engine")

    await current.withRestoredSubscription(subscription.id, async () => {
      await current.setSubscriptionState(subscription.id, "paused")
      const noteId = await current.createNote(`${current.caseId}-engine`, "engine delivery")
      const firstPausedRead = await current.post(api.query.note_query_note.path, { noteId: noteId.value })
      assert.equal(firstPausedRead.status, 404, "a paused subscription must not project a new note")
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const secondPausedRead = await current.post(api.query.note_query_note.path, { noteId: noteId.value })
      assert.equal(secondPausedRead.status, 404, "a paused subscription must remain unchanged")
      assert.deepEqual(
        (await current.history(noteId)).map((row) => row.event_name),
        ["NoteCreated"],
        "the event must persist while delivery is paused"
      )

      await current.setSubscriptionState(subscription.id, "running")
      await current.eventually(
        () => current.activeNote(noteId),
        (note) => note !== undefined
      )
      let cursor = ""
      let entries: Array<{ aggregate_id?: string; event_name?: string }> = []
      await current.eventually(
        async () => {
          const { response, body } = await current.engineRequest(
            `/api/dev/engine/logs${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`
          )
          assert.equal(response.status, 200, JSON.stringify(body))
          const page = body as {
            entries?: Array<{ aggregate_id?: string; event_name?: string }>
            nextCursor?: string
          }
          entries = entries.concat(page.entries ?? [])
          cursor = page.nextCursor ?? cursor
          return entries
        },
        (items) => items.some((entry) => entry.aggregate_id === noteId.value && entry.event_name === "NoteCreated")
      )
    })
  }))

test("two concurrent first sign-ins for the same email provision exactly one user and one workspace", async () =>
  live().runCase("concurrent-provisioning", async () => {
    const current = live()
    const email = `${current.caseId}@example.test`
    const dependencies = await configureDependencies().promise((error) => error)
    try {
      const [first, second] = await Promise.all([
        provisionUser(dependencies.withEventStore, email).promise((error) => new Error(JSON.stringify(error))),
        provisionUser(dependencies.withEventStore, email).promise((error) => new Error(JSON.stringify(error))),
      ])
      assert.equal(first.value, second.value)
      assert.deepEqual(
        (await current.history(User.idForEmail(email))).map((row) => row.event_name),
        ["UserJoined"]
      )
      assert.deepEqual(
        (await current.history(Workspace.idForOwner(first))).map((row) => row.event_name),
        ["WorkspaceProvisioned"]
      )
    } finally {
      await Promise.all([dependencies.postgres.disconnect(), dependencies.mongo.disconnect()])
    }
  }))
