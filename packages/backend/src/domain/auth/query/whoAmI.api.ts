export { type Query, type QueryResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { schema_actor } from "@be/app/actor"

const endpoint = new PlainEndpoint({
  path: "/api/v1/auth/query/who-am-i",
  request: s.object({}),
  response: s.object({ actor: schema_actor }),
})

type Query = s.Infer<typeof endpoint.request>
type QueryResponse = s.Infer<typeof endpoint.response>
