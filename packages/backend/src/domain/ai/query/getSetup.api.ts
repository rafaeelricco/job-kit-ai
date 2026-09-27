export { type Query, type QueryResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { schema_AiSetupView } from "@be/domain/ai/views"

const endpoint = new PlainEndpoint({
  path: "/api/v1/ai/query/setup",
  request: s.object({}),
  response: schema_AiSetupView,
})

type Query = s.Infer<typeof endpoint.request>
type QueryResponse = s.Infer<typeof endpoint.response>
