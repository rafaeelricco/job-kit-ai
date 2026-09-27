export { controller, handler }

import { type Response } from "@be/lib/router"
import { Failure } from "@lib/result"
import { type Command, type CommandResponse, endpoint } from "@be/domain/auth/command/verifyCode.api"
import { type CommandController, type CommandHandler } from "@be/app/handlers"
import { Auth, type GuardResult } from "@be/app/auth/policy"
import { internalServerError } from "@be/app/responses"
import { respond, parseEmail } from "@be/domain/auth/command/authErrors"
import { provisionUser } from "@be/domain/auth/provisionUser"

const authGuard = Auth.public()
type Result_ = GuardResult<typeof authGuard>

/** Trade a live code for a session (Set-Cookie), creating the user and workspace on first sign-in. */
const handler: CommandHandler<Command, CommandResponse, Result_> = ({ payload, loginCodes, session, withEventStore }) =>
  respond(parseEmail(payload.email)).chain((email) =>
    loginCodes
      .consume(email, payload.code.trim())
      .mapRej((): Response => internalServerError)
      .chain((valid) =>
        valid
          ? provisionUser(withEventStore, email).chain((userId) =>
              session
                .start(userId)
                .mapRej((): Response => internalServerError)
                .map(() => ({ userId }))
            )
          : respond<CommandResponse>(Failure({ type: "invalid_code" }))
      )
  )

const controller: CommandController<Command, CommandResponse, Result_> = { endpoint, authGuard, handler }
