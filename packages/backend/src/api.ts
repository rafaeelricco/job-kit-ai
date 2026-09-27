import { endpoint as auth_requestCode } from "@be/domain/auth/command/requestCode.api"
import { endpoint as auth_verifyCode } from "@be/domain/auth/command/verifyCode.api"
import { endpoint as auth_signOut } from "@be/domain/auth/command/signOut.api"
import { endpoint as auth_query_whoAmI } from "@be/domain/auth/query/whoAmI.api"
import { endpoint as ai_completeSetupStep } from "@be/domain/ai/command/completeSetupStep.api"
import { endpoint as ai_startAuthorization } from "@be/domain/ai/command/startAuthorization.api"
import { endpoint as ai_advanceAuthorization } from "@be/domain/ai/command/advanceAuthorization.api"
import { endpoint as ai_cancelAuthorization } from "@be/domain/ai/command/cancelAuthorization.api"
import { endpoint as ai_confirmSwitch } from "@be/domain/ai/command/confirmSwitch.api"
import { endpoint as ai_discardSwitch } from "@be/domain/ai/command/discardSwitch.api"
import { endpoint as ai_testConnection } from "@be/domain/ai/command/testConnection.api"
import { endpoint as ai_disconnect } from "@be/domain/ai/command/disconnect.api"
import { endpoint as ai_setPreferences } from "@be/domain/ai/command/setPreferences.api"
import { endpoint as ai_query_setup } from "@be/domain/ai/query/getSetup.api"

export const api = {
  command: {
    auth_requestCode,
    auth_verifyCode,
    auth_signOut,
    ai_completeSetupStep,
    ai_startAuthorization,
    ai_advanceAuthorization,
    ai_cancelAuthorization,
    ai_confirmSwitch,
    ai_discardSwitch,
    ai_testConnection,
    ai_disconnect,
    ai_setPreferences,
  },
  query: { auth_query_whoAmI, ai_query_setup },
}
