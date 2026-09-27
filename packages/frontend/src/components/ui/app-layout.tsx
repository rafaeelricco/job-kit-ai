export { AppLayout }

import { type CSSProperties, type ReactNode } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { AppSidebar } from "@components/ui/app-sidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@ui/sidebar"
import { ScrollArea } from "@ui/scroll-area"
import { SettingsDialog } from "@module/profile/components/settings-dialog"

function AppLayout({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams()

  const location = useLocation()
  const navigate = useNavigate()

  // Settings is a search param, not a path: the route behind it stays matched
  // and mounted, so the dialog opens over the page you were already on rather
  // than over a blank shell. Deep links and the back button both still work.
  const settingsOpen = params.has("settings")
  // The param's value is the panel, so a section is deep-linkable the way the
  // console's /settings/<section> is. Bare `?settings` still opens the first.
  const panel = params.get("settings") ?? ""
  const closeSettings = (next: boolean): void => {
    if (next) return
    // The account menu pushed this entry, so pop it rather than rewriting it:
    // replacing would leave two consecutive copies of the page behind the
    // dialog and make the next Back press look dead. A deep link carries no
    // such state and falls through to the replace below.
    if ((location.state as { settingsPushed?: boolean } | null)?.settingsPushed === true) {
      void navigate(-1)
      return
    }
    const rest = new URLSearchParams(params)
    rest.delete("settings")
    void setParams(rest, { replace: true })
  }
  // replace, not push: flipping through panels must not bury the page you were
  // on under seven history entries. The state rides along, since `setParams`
  // drops it otherwise and `closeSettings` would lose track of the entry this
  // app pushed.
  const selectPanel = (next: string): void => {
    const all = new URLSearchParams(params)
    all.set("settings", next)
    void setParams(all, { replace: true, state: location.state })
  }

  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden" style={{ "--sidebar-width": "16rem" } as CSSProperties}>
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0">
        {/* Below md the sidebar is a sheet, so its own trigger goes with it.
            Without this bar there is no way back to navigation on a phone. */}
        <ScrollArea className="min-h-0 min-w-0 flex-1" contentProps={{ className: "flex min-h-full flex-col" }}>
          <header className="flex h-12 shrink-0 items-center px-3 md:hidden">
            <SidebarTrigger />
          </header>
          {children}
        </ScrollArea>
      </SidebarInset>
      <SettingsDialog open={settingsOpen} panel={panel} onPanelChange={selectPanel} onOpenChange={closeSettings} />
    </SidebarProvider>
  )
}
