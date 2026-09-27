export { WorkspaceProvisioned }

import * as s from "@lib/json/schema"

import { type EventInfo, CreationEvent, Id, toSchema } from "@be/lib/event-sourcing/event"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"

const type = "WorkspaceProvisioned" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"Workspace">(),
  ownerId: Id.schema<"User">(),
})

class WorkspaceProvisioned extends CreationEvent<Workspace> {
  static readonly aggregate = Workspace
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  createAggregate(info: EventInfo): Workspace {
    return new Workspace({
      aggregateId: this.values.aggregateId,
      aggregateVersion: 0,
      ownerId: this.values.ownerId,
      createdAt: info.recorded_on,
    })
  }
}
