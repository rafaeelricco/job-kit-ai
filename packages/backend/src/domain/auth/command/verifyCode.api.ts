export { type Command, type CommandResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"

const endpoint = new PlainEndpoint({
  path: "/api/v1/auth/command/verify-code",
  request: s.object({
    email: s.string,
    code: s.string,
  }),
  response: s.object({ userId: Id.schema<"User">() }),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
