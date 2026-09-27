export { type Query, type QueryResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"
import { schema_noteDto } from "@be/domain/note/query/noteSchema"

const endpoint = new PlainEndpoint({
  path: "/api/v1/note/query/get-note",
  request: s.object({ noteId: Id.schema<"Note">() }),
  response: s.object({ note: schema_noteDto }),
})

type Query = s.Infer<typeof endpoint.request>
type QueryResponse = s.Infer<typeof endpoint.response>
