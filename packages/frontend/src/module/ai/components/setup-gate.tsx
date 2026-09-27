export { SetupGate }

import { type ReactNode } from "react"
import { Navigate } from "react-router-dom"

import { Failed, Loading, NotAsked, Ready } from "@lib/remote-data"
import { LoadingRows } from "@module/access/access-gate"
import { type AiSetupView } from "@module/ai/types"
import { useAiSetup } from "@module/ai/use-ai-setup"

/**
 * Steers an unfinished workspace to `/setup`. It steers only and protects nothing — a read that fails falls
 * through to the app rather than trapping a visitor behind a spinner (`Q1` in the onboarding plan).
 */
function SetupGate({ children }: { readonly children: ReactNode }) {
  const { state } = useAiSetup()
  return (
    state instanceof Ready ?
      mustSetUp(state.value) ? <Navigate to="/setup" replace />
      : children
    : state instanceof Loading || state instanceof NotAsked ? <LoadingRows />
    : state instanceof Failed ? children
    : (state satisfies never)
  )
}

/**
 * Gate condition (`Q1`, default option): setup is unfinished AND at least one route can actually connect. With the
 * API-key routes `live` (vault and account keys set) or the test adapter on, it fires; with neither, every route is
 * `"unproven"` and the app stays as it was.
 */
function mustSetUp(setup: AiSetupView): boolean {
  return !setup.setupCompleted && setup.routes.some((route) => route.availability !== "unproven")
}
