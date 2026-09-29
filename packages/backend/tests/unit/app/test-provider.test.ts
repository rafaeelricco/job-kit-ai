import express from "express"
import { createServer, type Server } from "node:http"
import assert from "node:assert/strict"
import { describe, test } from "vitest"

import { FakeProvider } from "@tests/support/test-provider/adapter"
import { testProviderRouter } from "@tests/support/test-provider/router"

const APP_URL = "http://localhost:5173/jobs/"

async function withRouter(run: (base: string, fake: FakeProvider) => Promise<void>): Promise<void> {
  const fake = new FakeProvider(APP_URL)
  const app = express()
  app.use("/api/dev/test-provider", testProviderRouter(fake))
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server did not bind")
  try {
    await run(`http://127.0.0.1:${address.port}/api/dev/test-provider`, fake)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

function post(
  base: string,
  path: string,
  fields: Record<string, string>,
  redirect: RequestRedirect = "follow"
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    redirect,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  })
}

describe("test provider router: device", () => {
  test("approve, deny, and expire each reach the fake provider", async () => {
    await withRouter(async (base, fake) => {
      const approved = fake.beginDevice("xai")
      const approveRes = await post(base, "/device", {
        user_code: approved.userCode,
        account: "tester@example.test",
        outcome: "approve",
      })
      assert.equal(approveRes.status, 200)
      assert.equal(fake.pollDevice(approved.deviceCode, { provider: "xai", method: "device" }).kind, "authorized")

      const denied = fake.beginDevice("xai")
      const denyRes = await post(base, "/device", { user_code: denied.userCode, account: "", outcome: "deny" })
      assert.equal(denyRes.status, 200)
      assert.equal(fake.pollDevice(denied.deviceCode, { provider: "xai", method: "device" }).kind, "denied")

      const expired = fake.beginDevice("xai")
      const expireRes = await post(base, "/device", { user_code: expired.userCode, account: "", outcome: "expire" })
      assert.equal(expireRes.status, 200)
      assert.equal(fake.pollDevice(expired.deviceCode, { provider: "xai", method: "device" }).kind, "expired")
    })
  })

  test("rejects an unknown user code with 404", async () => {
    await withRouter(async (base) => {
      const response = await post(base, "/device", { user_code: "ZZZZ-ZZZZ", account: "", outcome: "approve" })
      assert.equal(response.status, 404)
    })
  })

  test("escapes an account value reflected back on the confirmation page", async () => {
    await withRouter(async (base, fake) => {
      const begun = fake.beginDevice("xai")
      const response = await post(base, "/device", {
        user_code: begun.userCode,
        account: "<script>alert(1)</script>@example.test",
        outcome: "approve",
      })
      const body = await response.text()
      assert.ok(!body.includes("<script>"))
      assert.ok(body.includes("&lt;script&gt;"))
    })
  })

  test("rejects an outcome that is only an inherited property name", async () => {
    await withRouter(async (base, fake) => {
      const begun = fake.beginDevice("xai")
      const response = await post(base, "/device", { user_code: begun.userCode, account: "", outcome: "toString" })
      assert.equal(response.status, 400)
    })
  })
})

describe("test provider router: grants", () => {
  test("revoke updates the grant and redirects back to the list", async () => {
    await withRouter(async (base, fake) => {
      const secret = fake.accept({ provider: "anthropic", method: "api_key" }, "sk-good-key")
      assert.equal(secret.kind, "key")
      const grant = fake.grants()[0]
      if (grant === undefined) throw new Error("expected a grant to exist")

      const response = await post(base, "/grants", { id: grant.id, outcome: "revoked" }, "manual")
      assert.equal(response.status, 303)
      assert.equal(fake.grants()[0]?.status, "revoked")
    })
  })
})
