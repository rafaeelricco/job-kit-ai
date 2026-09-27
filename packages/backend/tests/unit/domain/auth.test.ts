import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Just, Nothing } from "@lib/maybe"
import { MemoryEventDatabase, MemorySessionStore, MemoryLoginCodes } from "@tests/support/memory"
import { result, rejection } from "@tests/support/notes"
import { controller as requestCode } from "@be/domain/auth/command/requestCode"
import { controller as verifyCode } from "@be/domain/auth/command/verifyCode"
import { controller as signOut } from "@be/domain/auth/command/signOut"
import { controller as whoAmI } from "@be/domain/auth/query/whoAmI"
import { type UserActor } from "@be/app/actor"
import { Session } from "@be/app/session"
import { User } from "@be/domain/user/aggregate/user"
import { type ReadProjections } from "@be/app/projections"
import { Id } from "@be/lib/event-sourcing/event"

const EMAIL = "user@example.test"

const anonymousAuth = { actor: { type: "Anonymous" as const }, auth: { result: "allow" as const } }

/** A fresh, unauthenticated `Session` handle over `sessions`. */
function anonSession(sessions: MemorySessionStore): Session {
  return new Session(sessions, Nothing())
}

async function askForCode(
  db: MemoryEventDatabase,
  sessions: MemorySessionStore,
  loginCodes: MemoryLoginCodes,
  email: string
) {
  return result(
    requestCode.handler({
      payload: { email },
      ...anonymousAuth,
      session: anonSession(sessions),
      loginCodes,
      withEventStore: db.withEventStore,
    })
  )
}

function submitCode(
  db: MemoryEventDatabase,
  session: Session,
  loginCodes: MemoryLoginCodes,
  email: string,
  code: string
) {
  return verifyCode.handler({
    payload: { email, code },
    ...anonymousAuth,
    session,
    loginCodes,
    withEventStore: db.withEventStore,
  })
}

describe("Auth commands and queries", () => {
  test("requestCode sends a code to any well-formed address and replies {}", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const loginCodes = new MemoryLoginCodes()

    const response = await askForCode(db, sessions, loginCodes, ` ${EMAIL.toUpperCase()} `)
    assert.deepEqual(response, {})
    assert.equal(loginCodes.live.has(EMAIL), true)
  })

  test("a malformed email is rejected before a code is sent", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const loginCodes = new MemoryLoginCodes()
    const error = await rejection(
      requestCode.handler({
        payload: { email: "not-an-email" },
        ...anonymousAuth,
        session: anonSession(sessions),
        loginCodes,
        withEventStore: db.withEventStore,
      })
    )
    assert.match(JSON.stringify(error), /400/)
    assert.equal(loginCodes.live.size, 0)
  })

  test("verifyCode with the sent code emits UserJoined then WorkspaceProvisioned, sets the sid cookie, and returns User.idForEmail", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const loginCodes = new MemoryLoginCodes()
    await askForCode(db, sessions, loginCodes, EMAIL)
    const code = loginCodes.live.get(EMAIL)
    assert.ok(code)

    const session = anonSession(sessions)
    const response = await result(submitCode(db, session, loginCodes, EMAIL, code))
    assert.equal(response.userId.value, User.idForEmail(EMAIL).value)
    assert.deepEqual(
      db.entries.map((entry) => entry.event_name),
      ["UserJoined", "WorkspaceProvisioned"]
    )
    assert.match(session.headers["Set-Cookie"] ?? "", /^sid=token-1; HttpOnly/)
  })

  test("a second sign-in with a fresh code emits nothing new and returns the same user id", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const loginCodes = new MemoryLoginCodes()
    const signIn = async () => {
      await askForCode(db, sessions, loginCodes, EMAIL)
      const code = loginCodes.live.get(EMAIL)
      assert.ok(code)
      return result(submitCode(db, anonSession(sessions), loginCodes, EMAIL, code))
    }
    const first = await signIn()
    const second = await signIn()
    assert.equal(second.userId.value, first.userId.value)
    assert.equal(db.entries.length, 2)
  })

  test("reusing a consumed code is rejected with 401 and sets no cookie", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const loginCodes = new MemoryLoginCodes()
    await askForCode(db, sessions, loginCodes, EMAIL)
    const code = loginCodes.live.get(EMAIL)
    assert.ok(code)
    await result(submitCode(db, anonSession(sessions), loginCodes, EMAIL, code))

    const session = anonSession(sessions)
    const error = await rejection(submitCode(db, session, loginCodes, EMAIL, code))
    assert.match(JSON.stringify(error), /401/)
    assert.deepEqual(session.headers, {})
  })

  test("a wrong code is rejected with 401, emits no events, and sets no cookie", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const loginCodes = new MemoryLoginCodes()
    await askForCode(db, sessions, loginCodes, EMAIL)

    const session = anonSession(sessions)
    const error = await rejection(submitCode(db, session, loginCodes, EMAIL, "000000"))
    assert.match(JSON.stringify(error), /401/)
    assert.equal(db.entries.length, 0)
    assert.deepEqual(session.headers, {})
  })

  test("signOut destroys the session and sends no clearing cookie", async () => {
    const db = new MemoryEventDatabase()
    const sessions = new MemorySessionStore()
    const userId = Id.random<"User">()
    const token = await sessions.create(userId).promise((error) => error)
    assert.equal(token, "token-1")
    const session = new Session(sessions, Just(token))
    const actor: UserActor = { type: "User", userId }
    await result(
      signOut.handler({
        payload: {},
        actor,
        auth: { result: "allow", actor },
        session,
        loginCodes: new MemoryLoginCodes(),
        withEventStore: db.withEventStore,
      })
    )
    assert.equal(sessions.sessions.has("token-1"), false)
    assert.equal(session.headers["Set-Cookie"], undefined)
  })

  test("whoAmI passes the resolved actor through unchanged", async () => {
    const projections = {} as ReadProjections
    const anonymous = await result(whoAmI.handler({ payload: {}, ...anonymousAuth, projections }))
    assert.deepEqual(anonymous, { actor: { type: "Anonymous" } })

    const actor: UserActor = { type: "User", userId: Id.random<"User">() }
    const signedIn = await result(whoAmI.handler({ payload: {}, actor, auth: { result: "allow" }, projections }))
    assert.deepEqual(signedIn, { actor })
  })
})
