import express from "express"
import { createServer, type Server } from "node:http"
import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { createEngineProxy } from "@be/app/engine"

async function withProxy(
  fetcher: typeof fetch,
  run: (base: string) => Promise<void>,
  proxyOptions: Parameters<typeof createEngineProxy>[0] = {}
): Promise<void> {
  const app = express()
  app.use(
    "/api/dev/engine",
    createEngineProxy({
      fetcher,
      baseUrl: "http://operator.test",
      token: "secret",
      ...proxyOptions,
    })
  )
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("test server did not bind")
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

describe("engine operator proxy", () => {
  test("forwards only fixed paths, bearer auth, and the log cursor", async () => {
    const calls: Array<{ url: string; auth: string; method: string }> = []
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        auth: String(new Headers(init?.headers).get("Authorization")),
        method: init?.method ?? "GET",
      })
      return new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    await withProxy(fetcher, async (base) => {
      const status = await fetch(`${base}/api/dev/engine/status`)
      assert.equal(status.status, 200)
      const logs = await fetch(`${base}/api/dev/engine/logs?after=cursor%2F1`)
      assert.equal(logs.status, 200)
      const pause = await fetch(`${base}/api/dev/engine/subscriptions/Note_Projection_Notes/pause`, { method: "POST" })
      assert.equal(pause.status, 200)
    })
    assert.deepEqual(calls, [
      {
        url: "http://operator.test/v1/status",
        auth: "Bearer secret",
        method: "GET",
      },
      {
        url: "http://operator.test/v1/logs?after=cursor%2F1",
        auth: "Bearer secret",
        method: "GET",
      },
      {
        url: "http://operator.test/v1/subscriptions/Note_Projection_Notes/pause",
        auth: "Bearer secret",
        method: "POST",
      },
    ])
  })

  test("turns an unavailable or non-JSON engine into an explicit bad gateway", async () => {
    const fetcher: typeof fetch = async () => new Response("engine failed", { status: 503 })
    await withProxy(fetcher, async (base) => {
      const response = await fetch(`${base}/api/dev/engine/status`)
      assert.equal(response.status, 502)
      const body = (await response.json()) as {
        error: { message: string; detail?: string }
      }
      assert.equal(body.error.message, "Engine operator returned HTTP 503")
      assert.equal(body.error.detail, undefined)
    })
  })

  test("rejects routes and methods outside the fixed operator surface", async () => {
    const calls: string[] = []
    const fetcher: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    }
    await withProxy(fetcher, async (base) => {
      const unknown = await fetch(base + "/api/dev/engine/diagnostics")
      const unsupportedAction = await fetch(base + "/api/dev/engine/subscriptions/note/delete", { method: "POST" })
      const unsupportedMethod = await fetch(base + "/api/dev/engine/status", { method: "DELETE" })

      assert.equal(unknown.status, 404)
      assert.equal(unsupportedAction.status, 404)
      assert.equal(unsupportedMethod.status, 404)
    })
    assert.deepEqual(calls, [])
  })
})
