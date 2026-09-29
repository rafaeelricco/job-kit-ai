export { classifyLlmError, withTransientRetry }

import { Future } from "@lib/future"

import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

type LlmFailure = "invalid" | "quota_exhausted" | "unreachable"

const MAX_ATTEMPTS = 3
const QUOTA = /quota|credit|billing/i
const BAD_KEY = /(incorrect|invalid) api key/i
const TRANSIENT_PATTERNS = [
  /terminated/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /socket hang up/i,
  /\b(502|503|504|529)\b/,
  /overloaded/i,
  /rate.?limit/i,
]

function statusOf(error: Error): number | undefined {
  return error instanceof OpenAI.APIError || error instanceof Anthropic.APIError ? error.status : undefined
}

function classifyLlmError(error: Error): LlmFailure {
  const status = statusOf(error)
  if (status === 402 || QUOTA.test(error.message)) return "quota_exhausted"
  if (status === 401 || status === 403 || (status === 400 && BAD_KEY.test(error.message))) return "invalid"
  return "unreachable"
}

function matchesTransientPattern(error: Error): boolean {
  const cause = error.cause instanceof Error ? error.cause.message : ""
  return TRANSIENT_PATTERNS.some((re) => re.test(`${error.message} ${cause}`))
}

function isTransientLlmError(error: Error): boolean {
  if (classifyLlmError(error) !== "unreachable") return false
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError) return true
  const status = statusOf(error)
  if (status !== undefined) return status === 408 || status === 409 || status === 429 || status >= 500
  return matchesTransientPattern(error)
}

function withTransientRetry<T>(make: () => Future<Error, T>, attempt = 0): Future<Error, T> {
  return make().chainRej((error) =>
    attempt + 1 < MAX_ATTEMPTS && isTransientLlmError(error)
      ? Future.resolveAfter<Error, void>(Math.min(8_000, 500 * 2 ** attempt), undefined).chain(() =>
          withTransientRetry(make, attempt + 1)
        )
      : Future.reject(error)
  )
}
