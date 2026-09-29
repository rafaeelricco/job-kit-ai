export { UserRegistered }

import * as s from "@lib/json/schema"

import { type EventInfo, CreationEvent, Id, toSchema } from "@be/lib/event-sourcing/event"
import { User } from "@be/domain/user/aggregate/user"

const type = "UserRegistered" as const
const args = s.object({
  type: s.stringLiteral(type),
  aggregateId: Id.schema<"User">(),
  email: s.string,
  passwordHash: s.string,
})

class UserRegistered extends CreationEvent<User> {
  static readonly aggregate = User
  static readonly type = type
  static readonly schema = toSchema(this, args)

  readonly values: s.Infer<typeof args>
  constructor(values: s.Infer<typeof args>) {
    super()
    this.values = values
  }

  createAggregate(info: EventInfo): User {
    return new User({
      aggregateId: this.values.aggregateId,
      aggregateVersion: 0,
      email: this.values.email,
      createdAt: info.recorded_on,
    })
  }
}
