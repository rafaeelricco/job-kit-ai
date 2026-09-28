import assert from "node:assert/strict"
import { afterAll, beforeAll, test } from "vitest"
import { api } from "@be/api"
import { configureDependencies } from "@be/app/integrations"
import { createLiveFixture, LiveFixture } from "@tests/support/live"
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

test("protected endpoints require a session, and a code sign-in/sign-out round-trips through the cookie", async () =>
  live().runCase("auth-session", async () => {
    const current = live()
    const anonymous = { Cookie: "" }
    assert.equal((await current.post(api.query.ai_query_setup.path, {}, anonymous)).status, 401)
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
    assert.equal((await current.post(api.query.ai_query_setup.path, {}, cookie)).status, 200)
    assert.equal((await current.post(api.command.auth_signOut.path, {}, cookie)).status, 200)
    assert.deepEqual(await (await current.post(api.query.auth_query_whoAmI.path, {}, cookie)).json(), {
      actor: { type: "Anonymous" },
    })
    assert.equal((await current.post(api.query.ai_query_setup.path, {}, cookie)).status, 401)
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
