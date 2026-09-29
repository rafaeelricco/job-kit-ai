export { Workspace }

import { POSIX } from "@lib/time"
import { type Aggregate, Id } from "@be/lib/event-sourcing/event"
import { type AiState } from "@be/domain/workspace/aggregate/aiState"

type WorkspaceValues = {
  readonly aggregateId: Id<"Workspace">
  readonly aggregateVersion: number
  readonly ownerId: Id<"User">
  readonly createdAt: POSIX
  readonly ai: AiState
}

class Workspace implements Aggregate<"Workspace"> {
  static readonly type = "Workspace"

  readonly values: WorkspaceValues
  constructor(values: WorkspaceValues) {
    this.values = values
  }

  get aggregateId(): Id<"Workspace"> {
    return this.values.aggregateId
  }

  get aggregateVersion(): number {
    return this.values.aggregateVersion
  }

  static idForOwner(ownerId: Id<"User">): Id<"Workspace"> {
    return Id.deterministicForAggregate<"Workspace", Workspace>(Workspace, ownerId.value).unwrap((message) => message)
  }
}
