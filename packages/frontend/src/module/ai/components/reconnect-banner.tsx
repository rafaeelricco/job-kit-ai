export { ReconnectBanner }

import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { Alert02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Ready } from "@lib/remote-data"
import { Button } from "@ui/button"
import { ConnectDialog, type ConnectRequest } from "@module/ai/components/connect-dialog"
import { PROVIDER_COPY, openProviderTab, opensTab } from "@module/ai/providers"
import { type ConnectionStatus, type ConnectionView } from "@module/ai/types"
import { useAiSetup } from "@module/ai/use-ai-setup"

type NeedsAttention = "revoked" | "expired" | "quota_exhausted"

const STATUS_COPY: Record<NeedsAttention, string> = {
  revoked: "Access was revoked.",
  expired: "Your sign-in expired.",
  quota_exhausted: "This account reached its usage limit.",
}

function needsReconnect(status: ConnectionStatus): status is NeedsAttention {
  return status === "revoked" || status === "expired" || status === "quota_exhausted"
}

/**
 * A10: shown above the shell's content on every workspace route once the active connection stops working on its
 * own — never for a connection the person disconnected on purpose, since that clears `active` entirely rather
 * than leaving it in one of the three failure statuses here. The reconnect dialog is rendered outside that
 * condition: a successful reconnect turns the status `ready`, which hides the banner, and the dialog has to stay
 * mounted to show its connected state (and to cancel its attempt if it's dismissed before then).
 */
function ReconnectBanner() {
  const { state, replace } = useAiSetup()
  const navigate = useNavigate()
  const [dialog, setDialog] = useState<{ readonly request: ConnectRequest; readonly tab: Window | null } | null>(null)

  const active = state instanceof Ready ? state.value.active : null

  const reconnect = (connection: ConnectionView): void => {
    const request: ConnectRequest =
      connection.method === "api_key" ?
        { kind: "apiKey", provider: connection.provider }
      : { kind: "route", route: { provider: connection.provider, method: connection.method } }
    // Synchronous with the click, so a device tab isn't blocked as script-timed.
    setDialog({ request, tab: opensTab(connection.method) ? openProviderTab() : null })
  }

  // Same destination the account menu's "Account settings" row uses (app-sidebar.tsx), landing on the AI panel.
  const openOtherRoute = (): void => {
    void navigate({ search: "?settings=ai" }, { state: { settingsPushed: true } })
  }

  return (
    <>
      {active !== null && needsReconnect(active.status) ?
        <div
          role="alert"
          className="mx-3 mt-3 flex flex-col gap-3 border border-warning-outline bg-warning-surface p-4 sm:flex-row sm:items-start md:mx-6 md:mt-6"
        >
          <div className="flex flex-1 items-start gap-3">
            <HugeiconsIcon icon={Alert02Icon} className="mt-0.5 size-[18px] shrink-0 text-warning" aria-hidden="true" />
            <div className="flex-1">
              <div className="font-medium text-ink-strong">
                Your {PROVIDER_COPY[active.provider].name} connection stopped working
              </div>
              <p className="text-[13px] text-ink-body">
                {STATUS_COPY[active.status]} New matching waits until you reconnect. Existing dossiers stay as they are.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" onClick={() => reconnect(active)}>
              Reconnect {PROVIDER_COPY[active.provider].name}
            </Button>
            <Button type="button" variant="ghost" onClick={openOtherRoute}>
              Other route…
            </Button>
          </div>
        </div>
      : null}
      {dialog !== null ?
        <ConnectDialog
          request={dialog.request}
          purpose="reconnect"
          tab={dialog.tab}
          current={active}
          onSetup={replace}
          onClose={() => setDialog(null)}
        />
      : null}
    </>
  )
}
