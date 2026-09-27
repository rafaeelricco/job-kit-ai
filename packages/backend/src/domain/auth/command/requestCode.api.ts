export { type Command, type CommandResponse, endpoint, RESEND_COOLDOWN_SECONDS }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"

/** Minimum gap between two sends to one address; the server ignores a resend inside it. */
const RESEND_COOLDOWN_SECONDS = 30

const endpoint = new PlainEndpoint({
  path: "/api/v1/auth/command/request-code",
  request: s.object({ email: s.string }),
  response: s.object({}),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
