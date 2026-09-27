export { SettingsDialog }

import { Cancel01Icon, UserIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@ui/dialog"
import { ScrollArea, ScrollBar } from "@ui/scroll-area"
import { cn } from "@components/utils"
import { ProfileGate } from "@module/profile/components/profile-gate"
import { PANELS, PANEL_ORDER, SettingsPanel, parsePanel } from "@module/profile/components/settings-surface"

// 896x720, square, no shadow: the frame measured off the reference console. The
// rail and panel are flex children of the dialog itself, so the panel scrolls
// alone and the rail stays put no matter how long a form runs. Below md the
// rail becomes a horizontal strip above the panel, as it does on the reference.
function SettingsDialog({
  open,
  panel,
  onPanelChange,
  onOpenChange,
}: {
  readonly open: boolean
  readonly panel: string
  readonly onPanelChange: (next: string) => void
  readonly onOpenChange: (open: boolean) => void
}) {
  const active = parsePanel(panel)
  const meta = PANELS[active]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[720px] max-h-[calc(100dvh-4rem)] flex-col gap-0 border border-divider bg-background p-0 sm:max-w-[896px] md:flex-row"
      >
        <nav className="flex min-h-0 min-w-0 shrink-0 flex-col gap-0.5 border-b border-divider p-3 md:w-48 md:border-r md:border-b-0">
          {/* Close sits before the label, as on the console: the dismiss
              affordance reads first on a surface with no title bar. */}
          <div className="flex shrink-0 items-center gap-2 px-2 pt-1 pb-2">
            <DialogClose className="text-ink-muted transition-colors hover:text-ink-strong">
              <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
            <DialogTitle className="font-mono text-xs font-medium tracking-wider text-ink-muted uppercase">
              Settings
            </DialogTitle>
          </div>

          {/* A button, not the console's anchor: the panel is a query param, and
              a <NavLink to={{search}}> would rewrite the whole search string and
              drop every other param on the route behind the dialog. */}
          <ScrollArea
            className="min-h-0 min-w-0 md:flex-1"
            viewportProps={{
              className:
                "h-auto overflow-x-auto! overflow-y-hidden! md:h-full md:overflow-x-hidden! md:overflow-y-auto!",
            }}
            contentProps={{
              className: "flex w-max min-w-full! flex-row gap-0.5 pb-2.5 md:w-auto md:min-w-0! md:flex-col md:pb-0",
            }}
          >
            {PANEL_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onPanelChange(id)}
                data-active={active === id}
                className={cn(
                  "flex shrink-0 items-center gap-2 px-2 py-1.5 text-left text-sm whitespace-nowrap transition-colors",
                  "text-ink-muted hover:bg-accent/50 hover:text-ink-body",
                  "data-active:bg-accent data-active:font-medium data-active:text-ink-body"
                )}
              >
                <HugeiconsIcon icon={PANELS[id].Icon} className="size-4 shrink-0" aria-hidden="true" />
                {PANELS[id].label}
              </button>
            ))}
            <ScrollBar orientation="horizontal" className="md:hidden" />
          </ScrollArea>
        </nav>

        {/* Header and body are siblings, so the title stays put while the body
            scrolls — the console's 4.25rem header, pl-9/pr-8 gutters and all. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex min-h-[4.25rem] shrink-0 items-center justify-between gap-4 pt-1 pr-8 pb-3 pl-9">
            <h2 className="truncate text-sm leading-none font-medium tracking-tight text-ink-muted">{meta.label}</h2>
            {meta.file !== null && <span className="font-mono text-xs text-ink-faint">data/{meta.file}</span>}
          </header>
          <ScrollArea className="min-h-0 min-w-0 flex-1" contentProps={{ className: "pt-2 pr-8 pb-8 pl-9" }}>
            <ProfileGate title="Account settings" Icon={UserIcon} chrome="bare">
              {(profile, save) => <SettingsPanel panel={active} profile={profile} save={save} />}
            </ProfileGate>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}
