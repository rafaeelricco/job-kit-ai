export { AiAuthorizationStarted }

import * as s from "@lib/json/schema"

import { POSIX } from "@lib/time"
import { type EventInfo, Id, toSchema, TransformationEvent } from "@be/lib/event-sourcing/event"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { schema_Provider, schema_Method, schema_Purpose } from "@be/domain/ai/routes"
import { applyAiEvent } from "@be/domain/workspace/aggregate/aiState"

const type = "AiAuthorizationStarted" as const
/** The "selected route" milestone: the first thing recorded once a user picks a provider/method to authorize. */
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"Workspace">(),
  attemptId: Id.schema<"AiAttempt">(),
  provider: schema_Provider,
  method: schema_Method,
  purpose: schema_Purpose,
  expiresAt: POSIX.schema,
})

class AiAuthorizationStarted extends TransformationEvent<Workspace> {
  static readonly aggregate = Workspace
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  transformAggregate(aggregate: Workspace, info: EventInfo): Workspace {
    return new Workspace({ ...aggregate.values, ai: applyAiEvent(aggregate.values.ai, this.values, info.recorded_on) })
  }
}
