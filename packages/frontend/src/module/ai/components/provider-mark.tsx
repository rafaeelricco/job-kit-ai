export { ProviderMark }

import { PROVIDER_COPY } from "@module/ai/providers"
import { type Provider } from "@module/ai/types"
import { cn } from "@components/utils"

const SIZE_CLASSES = {
  default: "size-8 text-[11px]",
  sm: "size-6 text-[10px]",
} as const

type ProviderMarkSize = keyof typeof SIZE_CLASSES

/** The 32px square provider monogram from the artboards (A2 cards, every route dialog's header, settings panel). */
function ProviderMark({
  provider,
  size = "default",
  className,
}: {
  readonly provider: Provider
  readonly size?: ProviderMarkSize
  readonly className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center border border-divider-emphasis bg-inset font-mono text-ink-body",
        SIZE_CLASSES[size],
        className
      )}
    >
      {PROVIDER_COPY[provider].mark}
    </span>
  )
}
