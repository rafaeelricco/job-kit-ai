export { controller, handler }

import { Future } from "@lib/future"
import { type Query, type QueryResponse, endpoint } from "@be/domain/auth/query/whoAmI.api"
import { type QueryController, type QueryHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"

const authGuard = Auth.public()

/** Who the session cookie resolves to; `Anonymous` without one. Public, so the handler reads `actor` itself. */
const handler: QueryHandler<Query, QueryResponse, GuardResult<typeof authGuard>> = ({ actor }) =>
  Future.resolve({ actor })

const controller: QueryController<Query, QueryResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
