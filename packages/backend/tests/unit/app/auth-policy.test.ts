import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { Auth } from "@be/app/auth/policy"
import { type Authorized, type GrantKey, getGrantData } from "@be/app/auth/grants"
import { type AuthContext } from "@be/app/resolveAuth"
import { Id } from "@be/lib/event-sourcing/event"

// Test-only catalog: pins the builders while production's catalogs are empty.
declare module "@be/app/auth/grants" {
  interface SystemCapabilities {
    ExampleSystem: true
    Shared: true
  }
  interface SessionCapabilities {
    ExampleSession: true
    Shared: true
  }
}

const anonymous: AuthContext = { actor: { type: "Anonymous" }, privileges: [] }
const user = (privileges: GrantKey[] = []): AuthContext => ({
  actor: { type: "User", userId: new Id<"User">("u-1") },
  privileges,
})

describe("Auth", () => {
  test("Auth.public allows an anonymous caller", () => {
    assert.deepEqual(Auth.public()(anonymous), { result: "allow" })
  })

  test("Auth.authenticated denies an anonymous caller and allows a signed-in one", () => {
    const guard = Auth.authenticated()

    const denied = guard(anonymous)
    assert.ok(denied.result === "deny")
    assert.equal(denied.status, 401)

    const allowed = guard(user())
    assert.ok(allowed.result === "allow")
    assert.equal(allowed.actor.type, "User")
  })

  test("Auth.system denies without a session, denies without the privilege, allows with it", () => {
    const guard = Auth.system("ExampleSystem")

    const anonymousResult = guard(anonymous)
    assert.ok(anonymousResult.result === "deny")
    assert.equal(anonymousResult.status, 401)

    const unprivileged = guard(user())
    assert.ok(unprivileged.result === "deny")
    assert.equal(unprivileged.status, 403)

    const allowed = guard(user(["system:ExampleSystem"]))
    assert.ok(allowed.result === "allow")
    assert.deepEqual(getGrantData("system:ExampleSystem", allowed), {})
  })

  test("Auth.session denies with the custom message and allows with the privilege", () => {
    const guard = Auth.session("ExampleSession", "Not impersonating")

    const denied = guard(user())
    assert.ok(denied.result === "deny")
    assert.equal(denied.status, 403)
    assert.equal(denied.message, "Not impersonating")

    const allowed = guard(user(["session:ExampleSession"]))
    assert.ok(allowed.result === "allow")
    assert.deepEqual(getGrantData("session:ExampleSession", allowed), {})
  })

  test("Auth.anyOf allows on the first passing guard and otherwise returns the last denial", () => {
    const guard = Auth.anyOf(Auth.system("ExampleSystem"), Auth.session("ExampleSession"))

    const allowed = guard(user(["session:ExampleSession"]))
    assert.ok(allowed.result === "allow")
    assert.deepEqual(getGrantData("session:ExampleSession", allowed), {})

    const denied = guard(user())
    assert.ok(denied.result === "deny")
    assert.equal(denied.status, 403)
  })

  test('a privilege is scoped: system:Shared does not satisfy Auth.session("Shared")', () => {
    const context = user(["system:Shared"])
    assert.ok(Auth.system("Shared")(context).result === "allow")
    const denied = Auth.session("Shared")(context)
    assert.ok(denied.result === "deny")
    assert.equal(denied.status, 403)
  })

  test("getGrantData throws when a proof minted for one key is read as another", () => {
    const guard = Auth.system("ExampleSystem")
    const allowed = guard(user(["system:ExampleSystem"]))
    assert.ok(allowed.result === "allow")

    assert.throws(
      () => getGrantData("session:ExampleSession", allowed as unknown as Authorized<"session:ExampleSession">),
      /Proof does not carry grant: session:ExampleSession/
    )
  })

  test("Auth.system is pinned to the capability catalog at compile time", () => {
    // @ts-expect-error -- "NotInCatalog" is not a key of SystemCapabilities.
    Auth.system("NotInCatalog")
  })
})
