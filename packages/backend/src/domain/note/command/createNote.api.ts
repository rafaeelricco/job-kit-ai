export { type Command, type CommandResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"

const endpoint = new PlainEndpoint({
  path: "/api/v1/note/command/create-note",
  request: s.object({
    noteId: Id.schema<"Note">(),
    title: s.string,
    body: s.string,
  }),
  response: s.object({ noteId: Id.schema<"Note">() }),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
