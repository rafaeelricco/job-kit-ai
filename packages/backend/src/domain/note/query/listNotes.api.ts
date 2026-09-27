export { type Query, type QueryResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { schema_noteDto } from "@be/domain/note/query/noteSchema"

const endpoint = new PlainEndpoint({
  path: "/api/v1/note/query/list-notes",
  request: s.object({}),
  response: s.object({ notes: s.array(schema_noteDto) }),
})

type Query = s.Infer<typeof endpoint.request>
type QueryResponse = s.Infer<typeof endpoint.response>
