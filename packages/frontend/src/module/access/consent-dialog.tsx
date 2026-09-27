export { ConsentDialog, type ConsentDialogProps }

import { Cancel01Icon, Files01Icon, HardDriveIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@ui/dialog"
import { ScrollArea } from "@ui/scroll-area"

type ConsentDialogProps = {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onAllow: () => void
}

const NOTES = [
  {
    lead: "You're in control",
    body: "This tab reads your folder in the browser and sends nothing to a server. It writes the data/ files you edit here, and a dossier you delete by hand — that one moves to scout/jobs/.trash rather than being erased.",
  },
  {
    lead: "What gets read",
    body: "The profile folder you choose — it must contain data/candidate.yaml and data/job_search.yaml — then every dossier under scout/jobs.",
  },
  {
    lead: "Where it stays",
    body: "The folder handle is remembered in this browser only (IndexedDB). Chrome or Edge on desktop is required. Revoke anytime in site settings.",
  },
] as const

function ConsentDialog(props: ConsentDialogProps) {
  const { onAllow, onOpenChange, open } = props

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => onOpenChange(next)}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] gap-0 p-0 sm:max-w-100">
        <ScrollArea
          viewportProps={{ className: "h-auto max-h-[calc(100dvh-2rem)]" }}
          contentProps={{ className: "flex flex-col gap-6 p-4" }}
        >
          <div>
            <div className="flex justify-end">
              <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
                <HugeiconsIcon icon={Cancel01Icon} />
                <span className="sr-only">Close</span>
              </DialogClose>
            </div>

            <div className="flex flex-col items-center">
              <div className="flex items-center gap-2.5">
                <span className="grid size-12 place-items-center border bg-surface">
                  <HugeiconsIcon icon={HardDriveIcon} className="size-6" />
                </span>
                <span className="flex gap-1" aria-hidden="true">
                  <span className="size-1.5 rounded-full bg-border" />
                  <span className="size-1.5 rounded-full bg-border" />
                  <span className="size-1.5 rounded-full bg-border" />
                </span>
                <span className="grid size-12 place-items-center border bg-surface">
                  <HugeiconsIcon icon={Files01Icon} className="size-6" />
                </span>
              </div>

              <DialogHeader className="items-center gap-0">
                <DialogTitle className="pt-3 text-center text-base font-semibold">
                  Read your job-kit profile
                </DialogTitle>
                <DialogDescription className="pt-1 text-center">
                  Nothing is read or changed until you allow it.
                </DialogDescription>
              </DialogHeader>
            </div>
          </div>

          <div className="border border-divider px-4 py-2">
            {NOTES.map((note) => (
              <div key={note.lead} className="flex flex-col gap-1 border-b py-2.5 last:border-b-0">
                <div className="text-sm font-medium">{note.lead}</div>
                <div className="text-xs text-muted-foreground">{note.body}</div>
              </div>
            ))}
          </div>

          <Button size="lg" onClick={onAllow} className="h-9 w-full">
            Choose profile folder
          </Button>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
