export { CopyButton }

import * as React from "react"

import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { toast } from "sonner"
import { cn } from "@components/utils"
import { Button } from "@ui/button"

const RESET_MS = 1200

function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  onCopied,
  variant = "outline",
  size = "sm",
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "value" | "onClick" | "children"> & {
  readonly value: string | (() => string)
  readonly label?: string
  readonly copiedLabel?: string
  readonly onCopied?: (copied: string) => void
}) {
  const [copied, setCopied] = React.useState(false)

  // StrictMode double-invokes effects, so the reset has to be cancellable.
  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), RESET_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = () => {
    const text = typeof value === "function" ? value() : value
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        onCopied?.(text)
      },
      () => toast.error("Could not copy to the clipboard")
    )
  }

  return (
    <Button
      data-slot="copy-button"
      variant={variant}
      size={size}
      onClick={copy}
      aria-label={copied ? copiedLabel : label}
      className={cn(className)}
      {...props}
    >
      {copied ?
        <HugeiconsIcon icon={Tick02Icon} />
      : <HugeiconsIcon icon={Copy01Icon} />}
      {copied ? copiedLabel : label}
    </Button>
  )
}
