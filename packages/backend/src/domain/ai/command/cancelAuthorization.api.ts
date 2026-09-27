export { type Command, type CommandResponse, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"
import { schema_AiSetupView } from "@be/domain/ai/views"

const endpoint = new PlainEndpoint({
  path: "/api/v1/ai/command/cancel-authorization",
  request: s.object({ attemptId: Id.schema<"AiAttempt">() }),
  response: s.object({ setup: schema_AiSetupView }),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
