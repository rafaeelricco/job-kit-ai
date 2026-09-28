export { api }
export { RESEND_COOLDOWN_SECONDS } from "@be/domain/auth/command/requestCode.api"
export { GOOGLE_START_PATH, type GoogleSignInError } from "@be/domain/auth/googleSignIn.api"

import { endpoint as whoAmI } from "@be/domain/auth/query/whoAmI.api"
import { endpoint as requestCode } from "@be/domain/auth/command/requestCode.api"
import { endpoint as verifyCode } from "@be/domain/auth/command/verifyCode.api"
import { endpoint as signOut } from "@be/domain/auth/command/signOut.api"
import { endpoint as aiSetup } from "@be/domain/ai/query/getSetup.api"
import { endpoint as completeSetupStep } from "@be/domain/ai/command/completeSetupStep.api"
import { endpoint as startAiAuthorization } from "@be/domain/ai/command/startAuthorization.api"
import { endpoint as advanceAiAuthorization } from "@be/domain/ai/command/advanceAuthorization.api"
import { endpoint as cancelAiAuthorization } from "@be/domain/ai/command/cancelAuthorization.api"
import { endpoint as confirmAiSwitch } from "@be/domain/ai/command/confirmSwitch.api"
import { endpoint as discardAiSwitch } from "@be/domain/ai/command/discardSwitch.api"
import { endpoint as testAiConnection } from "@be/domain/ai/command/testConnection.api"
import { endpoint as disconnectAi } from "@be/domain/ai/command/disconnect.api"
import { endpoint as setAiPreferences } from "@be/domain/ai/command/setPreferences.api"

/**
 * Every server call the app makes, by name. Paths and schemas stay in the server's `*.api.ts` files.
 */
const api = {
  whoAmI,
  requestCode,
  verifyCode,
  signOut,
  aiSetup,
  completeSetupStep,
  startAiAuthorization,
  advanceAiAuthorization,
  cancelAiAuthorization,
  confirmAiSwitch,
  discardAiSwitch,
  testAiConnection,
  disconnectAi,
  setAiPreferences,
} as const
