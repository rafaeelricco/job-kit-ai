export { createEngineProxy }

import { Future } from "@lib/future"
import { decode, json as jsonDecoder, stringified } from "@lib/json/decoder"
import { type Json } from "@lib/json/types"
import { type Result, Success, Failure } from "@lib/result"

import express from "express"
import env from "@be/app/environment"

const OPERATOR_TIMEOUT_MS = 35000

type ProxyConfig = {
  fetcher: typeof fetch
  baseUrl: string
  token: string
  timeoutMs: number
}

type ProxyError =
  { type: "upstream_status"; status: number } | { type: "invalid_json" } | { type: "timeout" } | { type: "unavailable" }

type Forwarded = { type: "empty"; status: number } | { type: "json"; status: number; body: Json }

function upstreamPath(path: string, query: express.Request["query"]): string {
  const url = new URL(path, "http://operator.invalid")
  const after = query["after"]
  if (typeof after === "string" && after.length > 0) url.searchParams.set("after", after)
  return `${url.pathname}${url.search}`
}

/** Decide what an upstream reply means. Pure: `fetchUpstream` does the I/O and feeds it in. */
function interpretUpstream(upstream: { ok: boolean; status: number }, text: string): Result<ProxyError, Forwarded> {
  if (!upstream.ok) return Failure({ type: "upstream_status", status: upstream.status })
  if (text.length === 0) return Success({ type: "empty", status: upstream.status })
  return decode(text, stringified(jsonDecoder)).either<Result<ProxyError, Forwarded>>(
    () => Failure({ type: "invalid_json" }),
    (body) => Success({ type: "json", status: upstream.status, body })
  )
}

/**
 * Fetch one upstream response and turn it into a `Forwarded` reply or a
 * `ProxyError`, respecting cancellation (aborts the request if the returned
 * `Future` is cancelled).
 *
 * ```ts
 * fetchUpstream(new URL("https://operator.internal/v1/status"), "GET", config)
 * ```
 */
function fetchUpstream(url: URL, method: "GET" | "POST", config: ProxyConfig): Future<ProxyError, Forwarded> {
  return Future.create<ProxyError, Forwarded>((reject, resolve) => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const upstream = await config.fetcher(url, {
          method,
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        })
        const text = await upstream.text()
        interpretUpstream(upstream, text).either(reject, resolve)
      } catch {
        reject({ type: "unavailable" })
      }
    })()
    return () => controller.abort()
  })
}

function withTimeout<T>(config: ProxyConfig, inner: Future<ProxyError, T>): Future<ProxyError, T> {
  const timeout = Future.create<ProxyError, T>((reject) => {
    const timer = setTimeout(() => reject({ type: "timeout" }), config.timeoutMs)
    return () => clearTimeout(timer)
  })
  return Future.race(inner, timeout)
}

function forward(path: string, method: "GET" | "POST", config: ProxyConfig): Future<ProxyError, Forwarded> {
  const url = new URL(path, `${config.baseUrl.replace(/\/$/, "")}/`)
  return withTimeout(config, fetchUpstream(url, method, config))
}

function errorMessage(error: ProxyError): string {
  switch (error.type) {
    case "upstream_status":
      return `Engine operator returned HTTP ${error.status}`
    case "invalid_json":
      return "Engine operator returned invalid JSON"
    case "timeout":
      return "Engine operator request timed out"
    case "unavailable":
      return "Engine operator is unavailable"
    default: {
      const exhaustiveCheck: never = error
      throw new Error(`Unknown proxy error: ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}

function sendError(error: ProxyError, response: express.Response): void {
  response.status(502).json({ error: { message: errorMessage(error) } })
}

function sendForwarded(forwarded: Forwarded, response: express.Response): void {
  switch (forwarded.type) {
    case "empty":
      response.status(forwarded.status).end()
      return
    case "json":
      response.status(forwarded.status).json(forwarded.body)
      return
    default: {
      const exhaustiveCheck: never = forwarded
      throw new Error(`Unknown forwarded response: ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}

type Method = "GET" | "POST"
const EXPRESS_METHOD = { GET: "get", POST: "post" } as const satisfies Record<Method, "get" | "post">

/** One proxied route. Route and upstream always share a method, so there is only one field for it. */
type ProxyRoute = { method: Method; route: string; upstream: (request: express.Request) => string }

const subscriptionAction = (action: "pause" | "resume"): ProxyRoute => ({
  method: "POST",
  route: `/subscriptions/:id/${action}`,
  upstream: (request) => `/v1/subscriptions/${encodeURIComponent(request.params["id"] ?? "")}/${action}`,
})

/** The whole surface the browser may reach on the engine operator. Anything not listed is a 404. */
const ROUTES: ReadonlyArray<ProxyRoute> = [
  { method: "GET", route: "/status", upstream: () => "/v1/status" },
  { method: "GET", route: "/subscriptions", upstream: () => "/v1/subscriptions" },
  { method: "GET", route: "/logs", upstream: (request) => upstreamPath("/v1/logs", request.query) },
  subscriptionAction("pause"),
  subscriptionAction("resume"),
]

function mount(router: express.Router, config: ProxyConfig, { method, route, upstream }: ProxyRoute): void {
  router[EXPRESS_METHOD[method]](route, (request, response) => {
    forward(upstream(request), method, config).fork(
      (error) => sendError(error, response),
      (forwarded) => sendForwarded(forwarded, response)
    )
  })
}

/**
 * Build the Express router that proxies the browser's engine-operator calls
 * to the real operator, adding the bearer token and a request timeout.
 * `options` overrides `ProxyConfig` for tests; production reads it from env.
 *
 * ```ts
 * app.use("/api/dev/engine", createEngineProxy())
 * ```
 */
function createEngineProxy(options: Partial<ProxyConfig> = {}): express.Router {
  const resolved: ProxyConfig = {
    fetcher: options.fetcher ?? fetch,
    baseUrl: options.baseUrl ?? env.ENGINE_OPERATOR_URL,
    token: options.token ?? env.ENGINE_OPERATOR_TOKEN,
    timeoutMs: options.timeoutMs ?? OPERATOR_TIMEOUT_MS,
  }
  const router = express.Router()

  ROUTES.forEach((route) => mount(router, resolved, route))

  return router
}
