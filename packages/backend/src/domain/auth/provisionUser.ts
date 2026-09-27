export { provisionUser }

import { Just } from "@lib/maybe"
import { type Response } from "@be/lib/router"
import { Future } from "@lib/future"
import { type WithEventStore } from "@be/lib/event-sourcing/store"
import { Id } from "@be/lib/event-sourcing/event"
import { internalServerError } from "@be/app/responses"
import { User } from "@be/domain/user/aggregate/user"
import { UserJoined } from "@be/domain/user/events/user/userJoined"
import { Workspace } from "@be/domain/workspace/aggregate/workspace"
import { WorkspaceProvisioned } from "@be/domain/workspace/events/workspace/workspaceProvisioned"

/**
 * The user behind a verified `email`, created with their workspace on first sign-in. Both ids are derived
 * (`User.idForEmail`, `Workspace.idForOwner`), so repeat sign-ins find what exists, and two racing first
 * sign-ins collide on aggregate version 0; the store's retry reruns the loser, which then finds both.
 * `email` must be verified by the caller: an emailed code or Google's `email_verified`.
 */
function provisionUser(withEventStore: WithEventStore, email: string): Future<Response, Id<"User">> {
  return withEventStore(
    () => internalServerError,
    function* (store) {
      const userId = User.idForEmail(email)
      if (!((yield* store.try_find(User, userId)) instanceof Just))
        yield* store.emit({
          aggregate: User,
          event: new UserJoined({ type: UserJoined.type, aggregateId: userId, email }),
        })
      const workspaceId = Workspace.idForOwner(userId)
      if (!((yield* store.try_find(Workspace, workspaceId)) instanceof Just))
        yield* store.emit({
          aggregate: Workspace,
          event: new WorkspaceProvisioned({
            type: WorkspaceProvisioned.type,
            aggregateId: workspaceId,
            ownerId: userId,
          }),
        })
      return userId
    }
  )
}
