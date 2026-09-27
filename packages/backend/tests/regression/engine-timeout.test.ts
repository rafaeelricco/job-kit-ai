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

describe("engine operator proxy timeout", () => {
  test("turns a stalled response body into a timeout bad gateway", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const signal = init?.signal
      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
          }),
      } as Response
    }
    await withProxy(
      fetcher,
      async (base) => {
        const response = await fetch(`${base}/api/dev/engine/status`)
        assert.equal(response.status, 502)
        assert.equal((await response.json()).error.message, "Engine operator request timed out")
      },
      { timeoutMs: 10 }
    )
  })
})
