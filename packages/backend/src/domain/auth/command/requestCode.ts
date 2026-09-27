export { controller, handler }

import { type Response } from "@be/lib/router"
import { type Command, type CommandResponse, endpoint } from "@be/domain/auth/command/requestCode.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { internalServerError } from "@be/app/responses"
import { respond, parseEmail } from "@be/domain/auth/command/authErrors"

/** Public: asking for a code is how a caller starts signing in. */
const authGuard = Auth.public()
type Result_ = GuardResult<typeof authGuard>

/** Email a sign-in code to any well-formed address. */
const handler: CommandHandler<Command, CommandResponse, Result_> = ({ payload, loginCodes }) =>
  respond(parseEmail(payload.email)).chain((email) =>
    loginCodes
      .send(email)
      .mapRej((): Response => internalServerError)
      .map(() => ({}))
  )

const controller: CommandController<Command, CommandResponse, Result_> = { endpoint, authGuard, handler }
