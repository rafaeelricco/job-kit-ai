export { type Command, type CommandResponse, type StepRequest, endpoint }

import * as s from "@lib/json/schema"

import { PlainEndpoint } from "@be/app/endpoint"
import { Id } from "@be/lib/event-sourcing/event"
import { schema_AiSetupView, schema_AuthorizationStatus } from "@be/domain/ai/views"

/** Wire shape of `app/ai/authorize.ts`'s `Step`. */
const schema_StepRequest = s.discriminatedUnion([
  s.variant({ kind: "poll" }),
  s.variant({ kind: "secret", secret: s.string }),
  s.variant({ kind: "retry" }),
])
type StepRequest = s.Infer<typeof schema_StepRequest>

const endpoint = new PlainEndpoint({
  path: "/api/v1/ai/command/advance-authorization",
  request: s.object({ attemptId: Id.schema<"AiAttempt">(), step: schema_StepRequest }),
  response: s.object({ status: schema_AuthorizationStatus, setup: schema_AiSetupView }),
})

type Command = s.Infer<typeof endpoint.request>
type CommandResponse = s.Infer<typeof endpoint.response>
