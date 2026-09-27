export { ProtectedRoute }

import { type ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { type Session } from "@module/session/session"
import { returnState } from "@module/session/helpers/return-to"

/** A cached user never waits; an anonymous visitor waits one round trip instead of bouncing to /sign-in early. */
function ProtectedRoute({ session, children }: { session: Session; children: ReactNode }) {
  const location = useLocation()
  return (
    session.type === "Checking" ? <SessionPending />
    : session.type === "SignedOut" ? <Navigate to="/sign-in" replace state={returnState(location)} />
    : session.type === "SignedIn" ? children
    : (session satisfies never)
  )
}

function SessionPending() {
  return (
    <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Checking your session…</div>
  )
}
