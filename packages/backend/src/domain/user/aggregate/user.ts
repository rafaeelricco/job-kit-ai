export { User }

import { POSIX } from "@lib/time"
import { type Aggregate, Id } from "@be/lib/event-sourcing/event"

type UserValues = {
  readonly aggregateId: Id<"User">
  readonly aggregateVersion: number
  readonly email: string
  readonly createdAt: POSIX
}

class User implements Aggregate<"User"> {
  static readonly type = "User"

  readonly values: UserValues
  constructor(values: UserValues) {
    this.values = values
  }

  get aggregateId(): Id<"User"> {
    return this.values.aggregateId
  }

  get aggregateVersion(): number {
    return this.values.aggregateVersion
  }

  /**
   * The id is derived from the normalized email, so the event stream itself
   * enforces one account per email — no uniqueness index to keep in sync.
   * The seed is `User:<email>`, never empty, so derivation cannot fail.
   */
  static idForEmail(email: string): Id<"User"> {
    return Id.deterministicForAggregate<"User", User>(User, email).unwrap((message) => message)
  }
}
