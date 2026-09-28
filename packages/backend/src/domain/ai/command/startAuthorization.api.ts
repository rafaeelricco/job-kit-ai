export { type Command, type CommandResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"
import { schema_Provider, schema_Method, schema_Purpose } from "@be/domain/ai/routes"
import { schema_AiSetupView, schema_AuthorizationStatus } from "@be/domain/ai/views"

const endpoint = new PlainEndpoint({
  path: "/api/v1/ai/command/start-authorization",
  request: s.object({ provider: schema_Provider, method: schema_Method, purpose: schema_Purpose }),
  response: s.object({
    attemptId: Id.schema<"AiAttempt">(),
    status: schema_AuthorizationStatus,
    setup: schema_AiSetupView,
  }),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
