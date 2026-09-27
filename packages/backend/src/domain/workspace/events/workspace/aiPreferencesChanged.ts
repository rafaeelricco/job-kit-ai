export { AiPreferencesChanged }

import * as s from "@lib/json/schema"

import { type EventInfo, Id, toSchema, TransformationEvent } from "@be/lib/event-sourcing/event"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { schema_Effort } from "@be/domain/ai/routes"
import { applyAiEvent } from "@be/domain/workspace/aggregate/aiState"

const type = "AiPreferencesChanged" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"Workspace">(),
  connectionId: Id.schema<"AiConnection">(),
  model: s.string,
  effort: schema_Effort,
})

class AiPreferencesChanged extends TransformationEvent<Workspace> {
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
