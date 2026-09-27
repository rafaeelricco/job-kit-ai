export { PermissionEmpty }

import { Button } from "@ui/button"

type PermissionEmptyKind = "no-handle" | "prompt" | "denied" | "stale" | "unsupported"

type PermissionEmptyProps = {
  readonly kind: PermissionEmptyKind
  readonly onPrimary: () => void
  readonly onReview?: () => void
}

const COPY: Record<
  PermissionEmptyKind,
  { readonly title: string; readonly body: string; readonly primary: string | null }
> = {
  "no-handle": {
    title: "Permission not granted",
    body: "Your dossiers are on this machine, but this page has no folder selected yet.",
    primary: "Choose profile folder",
  },
  prompt: {
    title: "Allow access again",
    body: "This browser still knows your folder, but needs permission to read it this visit.",
    primary: "Continue",
  },
  denied: {
    title: "Access blocked",
    body: "Site settings blocked folder access. In Chrome or Edge: site settings → File editing / View files and folders → allow, then try again.",
    primary: "Try again",
  },
  stale: {
    title: "Folder missing",
    body: "The saved folder was moved, renamed, or deleted. Choose it again.",
    primary: "Choose folder again",
  },
  unsupported: {
    title: "Unsupported browser",
    body: "Folder access needs Chrome or Edge on desktop over HTTPS (or localhost).",
    primary: null,
  },
}

function PermissionEmpty({ kind, onPrimary, onReview }: PermissionEmptyProps) {
  const copy = COPY[kind]

  return (
    <div className="grid flex-1 place-items-center px-6 py-12">
      <div className="flex w-full max-w-100 flex-col items-center text-center">
        <img src={`${import.meta.env.BASE_URL}permission-not-granted.png`} alt="" className="size-56 object-contain" />
        <h1 className="pt-3 text-base font-semibold">{copy.title}</h1>
        <p className="pt-1 text-sm text-balance text-muted-foreground">{copy.body}</p>
        {copy.primary === null ? null : (
          <div className="flex w-full flex-col gap-2 pt-6 sm:flex-row">
            <Button size="lg" onClick={onPrimary} className="h-9 flex-1">
              {copy.primary}
            </Button>
            {onReview === undefined ? null : (
              <Button size="lg" variant="outline" onClick={onReview} className="h-9 flex-1">
                Review permissions
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
