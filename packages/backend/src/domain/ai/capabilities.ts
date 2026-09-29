export {
  schema_Model,
  schema_Capabilities,
  schema_Preferences,
  defaultPreferences,
  checkPreferences,
  maskAccount,
  billingLabel,
  type Model,
  type Capabilities,
  type Preferences,
  type PreferenceError,
}

import * as s from "@lib/json/schema"

import { type Result, Success, Failure } from "@lib/result"

import { schema_Effort, type Effort, type Provider, type Route } from "@be/domain/ai/routes"

/** Client-safe: this file (and everything it imports) never reaches pg, mongo, express, node:crypto, or `@be/app/*`. */

const schema_Model = s.object({
  id: s.string,
  summary: s.string,
  recommended: s.boolean,
  efforts: s.array(schema_Effort),
  usable: s.boolean,
  reason: s.nullable(s.string), // why Job Kit can't use it; null when usable
})
type Model = s.Infer<typeof schema_Model>

const schema_Capabilities = s.object({
  account: s.string, // masked
  billing: s.string,
  models: s.array(schema_Model),
})
type Capabilities = s.Infer<typeof schema_Capabilities>

const schema_Preferences = s.object({ model: s.string, effort: schema_Effort })
type Preferences = s.Infer<typeof schema_Preferences>

type PreferenceError = "unknown_model" | "model_unusable" | "effort_unsupported"

const DEFAULT_EFFORT: Effort = "medium"

/** The recommended usable model, at medium when it supports it, else its first effort. */
function defaultPreferences(caps: Capabilities): Preferences {
  const chosen =
    caps.models.find((m) => m.recommended && m.usable) ?? caps.models.find((m) => m.usable) ?? caps.models[0]
  if (chosen === undefined) {
    // `verify` never returns an empty model list in practice; kept total rather than throwing.
    return { model: "", effort: DEFAULT_EFFORT }
  }
  const effort = chosen.efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (chosen.efforts[0] ?? DEFAULT_EFFORT)
  return { model: chosen.id, effort }
}

/** The only gate on saved preferences; the API applies it whatever the UI sent. */
function checkPreferences(caps: Capabilities, p: Preferences): Result<PreferenceError, Preferences> {
  const model = caps.models.find((m) => m.id === p.model)
  if (model === undefined) return Failure("unknown_model")
  if (!model.usable) return Failure("model_unusable")
  if (!model.efforts.includes(p.effort)) return Failure("effort_unsupported")
  return Success(p)
}

/** `"tester@example.test"` → `"t•••@example.test"`. */
function maskAccount(account: string): string {
  const at = account.indexOf("@")
  if (at <= 0) return "•••"
  return `${account.slice(0, 1)}•••${account.slice(at)}`
}

const API_KEY_BILLING: Record<Provider, string> = {
  anthropic: "Your Anthropic API account",
  xai: "Your xAI API account",
}

const SUBSCRIPTION_BILLING: Record<Provider, string> = {
  anthropic: "Your Claude subscription",
  xai: "Your xAI account",
}

/** Whose bill a connection runs on: an API key bills the API account, a sign-in the subscription. Total over every route. */
function billingLabel(route: Route): string {
  return route.method === "api_key" ? API_KEY_BILLING[route.provider] : SUBSCRIPTION_BILLING[route.provider]
}
