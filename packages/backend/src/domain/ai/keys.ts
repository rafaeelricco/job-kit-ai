export { checkApiKey }

import { type Maybe, Just, Nothing } from "@lib/maybe"

import { type Provider } from "@be/domain/ai/routes"

/** Client-safe: this file (and everything it imports) never reaches pg, mongo, express, node:crypto, or `@be/app/*`. */

const KEY_PREFIX: Record<Provider, string> = { openai: "sk-", anthropic: "sk-ant-api", xai: "xai-" }
const MIN_LENGTH = 20

/** A shape check only, so an obvious typo never reaches the provider: `Just(message)` when `value` can't be this provider's key. */
function checkApiKey(provider: Provider, value: string): Maybe<string> {
  const key = value.trim()
  const prefix = KEY_PREFIX[provider]
  if (!key.startsWith(prefix)) return Just(`Expected a key starting with ${prefix}`)
  if (key.length < MIN_LENGTH) return Just("That key looks too short. Paste the whole key.")
  return Nothing()
}
