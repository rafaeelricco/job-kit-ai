export { Workspace }

import { POSIX } from "@lib/time"
import { type Aggregate, Id } from "@be/lib/event-sourcing/event"
import { type AiState } from "@be/domain/workspace/aggregate/aiState"

type WorkspaceValues = {
  readonly aggregateId: Id<"Workspace">
  readonly aggregateVersion: number
  readonly ownerId: Id<"User">
  readonly createdAt: POSIX
  /** Setup progress and the AI connection registry: one active connection, at most one staged by a switch. */
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

  /** Derived from the owner, so the event stream itself allows one workspace per user, as `User.idForEmail` does per email. */
  static idForOwner(ownerId: Id<"User">): Id<"Workspace"> {
    return Id.deterministicForAggregate<"Workspace", Workspace>(Workspace, ownerId.value).unwrap((message) => message)
  }
}
