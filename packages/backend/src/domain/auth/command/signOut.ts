export { controller, handler }

import { type Response } from "@be/lib/router"
import { type Command, type CommandResponse, endpoint } from "@be/domain/auth/command/signOut.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { internalServerError } from "@be/app/responses"

/** Authenticated, so signing out without a session is a 401 rather than a silent no-op. */
const authGuard = Auth.authenticated()

/** End the caller's session: delete it server-side, which leaves the cookie's token resolving to anonymous. */
const handler: CommandHandler<Command, CommandResponse, GuardResult<typeof authGuard>> = ({ session }) =>
  session
    .end()
    .mapRej((): Response => internalServerError)
    .map(() => ({}))

const controller: CommandController<Command, CommandResponse, GuardResult<typeof authGuard>> = {
  endpoint,
  authGuard,
  handler,
}
