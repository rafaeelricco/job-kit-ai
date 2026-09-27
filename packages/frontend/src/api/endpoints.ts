export { api }
export { RESEND_COOLDOWN_SECONDS } from "@be/domain/auth/command/requestCode.api"
export { GOOGLE_START_PATH, type GoogleSignInError } from "@be/domain/auth/googleSignIn.api"

import { endpoint as whoAmI } from "@be/domain/auth/query/whoAmI.api"
import { endpoint as requestCode } from "@be/domain/auth/command/requestCode.api"
import { endpoint as verifyCode } from "@be/domain/auth/command/verifyCode.api"
import { endpoint as signOut } from "@be/domain/auth/command/signOut.api"

/**
 * Every server call the app makes, by name. Paths and schemas stay in the server's `*.api.ts` files. They are
 * imported one by one rather than through `@be/api`, whose note endpoints reach server-only modules (pg, mongo).
 */
const api = { whoAmI, requestCode, verifyCode, signOut } as const
