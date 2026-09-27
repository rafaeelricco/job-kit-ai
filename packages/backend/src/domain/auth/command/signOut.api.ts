export { type Command, type CommandResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"

const endpoint = new PlainEndpoint({
  path: "/api/v1/auth/command/sign-out",
  request: s.object({}),
  response: s.object({}),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
