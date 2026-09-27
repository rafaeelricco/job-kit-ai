import { Nothing } from "@lib/maybe"
import { type UserActor } from "@be/app/actor"
import { Session } from "@be/app/session"
import { Id } from "@be/lib/event-sourcing/event"
import { MemorySessionStore, MemoryLoginCodes } from "@tests/support/memory"

export const testUser: UserActor = { type: "User", userId: new Id<"User">("test-user") }

/** What a note query handler receives behind `Auth.authenticated()`. */
export const asUser = { actor: testUser, auth: { result: "allow" } as const }

/** What a note command handler receives: the query context plus a session. */
export function asUserCommand(sessions = new MemorySessionStore()) {
  return { ...asUser, session: new Session(sessions, Nothing()), loginCodes: new MemoryLoginCodes() }
}
