export { retryFor, pendingStatus, failedStatus, connectedStatus }

import { type Attempt } from "@be/app/ai/store/attempts"
import { type AuthorizationStatus, type FailureReason } from "@be/domain/ai/views"

/**
 * Shared by `startAuthorization.ts` and `advanceAuthorization.ts`: builders for the `AuthorizationStatus` half of
 * their response. `verify`: a fresh verify might still succeed on its own (quota clears, the network recovers).
 * `restart`: the flow itself has to begin again (a new code, a fresh consent screen, a corrected entry).
 */
function retryFor(reason: FailureReason): "verify" | "restart" {
  return reason === "quota_exhausted" || reason === "unreachable" ? "verify" : "restart"
}

function pendingStatus(attempt: Attempt): AuthorizationStatus {
  return { status: "pending", challenge: attempt.challenge, expiresAt: attempt.expiresAt }
}

function failedStatus(reason: FailureReason): AuthorizationStatus {
  return { status: "failed", reason, retry: retryFor(reason) }
}

function connectedStatus(role: "active" | "staged"): AuthorizationStatus {
  return { status: "connected", role }
}
