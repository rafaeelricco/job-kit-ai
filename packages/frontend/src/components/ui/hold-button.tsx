export { HoldButton }

import * as React from "react"

import { cn } from "@components/utils"
import { Button } from "@ui/button"

function HoldButton({
  onHold,
  holdMs = 2000,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "onClick"> & {
  readonly onHold: () => void
  readonly holdMs?: number
}) {
  const [holding, setHolding] = React.useState(false)
  // The ref is the re-entrancy guard, not the state: key-repeat fires keydown
  // again before React re-renders, so a state guard would let a second timer
  // through. `holding` exists only to drive the fill.
  const timer = React.useRef<number | undefined>(undefined)

  const stop = React.useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    setHolding(false)
  }, [])

  React.useEffect(() => stop, [stop])

  const start = () => {
    if (timer.current !== undefined) return
    setHolding(true)
    timer.current = window.setTimeout(() => {
      stop()
      onHold()
    }, holdMs)
  }

  return (
    <Button
      data-slot="hold-button"
      {...props}
      className={cn("relative touch-none overflow-hidden", className)}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onBlur={stop}
      onKeyUp={stop}
      onKeyDown={(event) => {
        // Pointer-only would leave the action unreachable by keyboard.
        if (event.key !== " " && event.key !== "Enter") return
        event.preventDefault()
        start()
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-current/20 ease-linear"
        style={{
          width: holding ? "100%" : 0,
          transitionProperty: "width",
          transitionDuration: `${holding ? holdMs : 120}ms`,
        }}
      />
      <span className="relative inline-flex items-center gap-1.5">{children}</span>
    </Button>
  )
}
