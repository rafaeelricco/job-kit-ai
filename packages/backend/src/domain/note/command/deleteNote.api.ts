export { type Command, type CommandResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"

const endpoint = new PlainEndpoint({
  path: "/api/v1/note/command/delete-note",
  request: s.object({ noteId: Id.schema<"Note">() }),
  response: s.object({ success: s.boolean }),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
