export { type Actor, type UserActor, schema_actor }

import * as s from "@lib/json/schema"
import { Id } from "@be/lib/event-sourcing/event"

/** Who is making a request: `Anonymous` until a session cookie resolves to a user. */
const schema_actor = s.discriminatedUnion([
  s.variant({ type: "Anonymous" }),
  s.variant({ type: "User", userId: Id.schema<"User">() }),
])

// Derived from the schema so the wire shape (whoAmI) and the type cannot drift.
type Actor = s.Infer<typeof schema_actor>
type UserActor = Extract<Actor, { type: "User" }>
