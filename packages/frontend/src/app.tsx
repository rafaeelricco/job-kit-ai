export { App }

import { lazy, Suspense, useEffect, useState } from "react"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { Just } from "@lib/maybe"
import { initialSession, reloadSession, subscribeToSessionUpdates, type Session } from "@module/session/session"
import { ProtectedRoute } from "@module/session/components/protected-route"
import { AppLayout } from "@components/ui/app-layout"
import { AiSetupProvider } from "@module/ai/use-ai-setup"
import { SetupGate } from "@module/ai/components/setup-gate"

const AnswersPage = lazy(() => import("@pages/answers"))
const DossiersPage = lazy(() => import("@pages/dossiers"))
const HomePage = lazy(() => import("@pages/home"))
const NotFoundPage = lazy(() => import("@pages/not-found"))
const RecommendationsPage = lazy(() => import("@pages/recommendations"))
const ResumesPage = lazy(() => import("@pages/resumes"))
const SetupPage = lazy(() => import("@pages/setup"))
const SignInPage = lazy(() => import("@pages/sign-in"))
const TermsPage = lazy(() => import("@pages/legal").then((m) => ({ default: m.TermsPage })))
const PrivacyPage = lazy(() => import("@pages/legal").then((m) => ({ default: m.PrivacyPage })))

const basename = import.meta.env.BASE_URL.replace(/\/$/, "")

/** The signed-in workspace: the sidebar shell around the scout and profile pages, gated on setup being finished. */
function WorkspaceRoutes() {
  return (
    <SetupGate>
      <AppLayout>
        {/* Inside the shell, so a page loading its chunk leaves the sidebar on screen. */}
        <Suspense>
          <Routes>
            <Route index element={<HomePage />} />
            <Route path="dossiers" element={<DossiersPage />} />
            <Route path="resumes" element={<ResumesPage />} />
            <Route path="recommendations" element={<RecommendationsPage />} />
            <Route path="answers" element={<AnswersPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </AppLayout>
    </SetupGate>
  )
}

/**
 * The app's root: the one owner of `Session`, handed to routes as a prop.
 * A cached user renders at once while `whoAmI` revalidates in the background.
 */
function App() {
  const [session, setSession] = useState<Session>(initialSession)

  useEffect(() => {
    // Every write (reload, sign-in, sign-out, another tab) lands here, so the reload's success needs no handler.
    const unsubscribe = subscribeToSessionUpdates(setSession)
    const cancel = reloadSession().fork(
      // A cached user stays signed in when the server can't be reached.
      (error) => setSession((prev) => (prev.type === "SignedIn" ? prev : { type: "SignedOut", error: Just(error) })),
      () => {}
    )
    return () => {
      cancel()
      unsubscribe()
    }
  }, [])

  return (
    <BrowserRouter basename={basename}>
      {/* One setup cell for every route, so a command's fresh `setup` survives navigating from /setup to the
          workspace (the `aiSetup` projection lags commands). Keyed on the user: a new account starts a new cell. */}
      <AiSetupProvider
        key={session.type === "SignedIn" ? session.user.userId.value : "signed-out"}
        enabled={session.type === "SignedIn"}
      >
        <Suspense>
          <Routes>
            <Route path="/sign-in" element={<SignInPage session={session} />} />
            <Route path="/legal/terms" element={<TermsPage />} />
            <Route path="/legal/privacy" element={<PrivacyPage />} />
            {/* Protected but chrome-less: the wizard owns the whole screen until setup is done. */}
            <Route
              path="/setup"
              element={
                <ProtectedRoute session={session}>
                  <SetupPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/*"
              element={
                <ProtectedRoute session={session}>
                  <WorkspaceRoutes />
                </ProtectedRoute>
              }
            />
          </Routes>
        </Suspense>
      </AiSetupProvider>
    </BrowserRouter>
  )
}
