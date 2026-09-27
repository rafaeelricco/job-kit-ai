export { ScrollArea, ScrollBar }

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import { cn } from "@components/utils"

type ScrollAreaProps = ScrollAreaPrimitive.Root.Props & {
  viewportProps?: Omit<ScrollAreaPrimitive.Viewport.Props, "children">
  contentProps?: Omit<ScrollAreaPrimitive.Content.Props, "children">
}

function ScrollArea({ className, children, viewportProps = {}, contentProps = {}, ...props }: ScrollAreaProps) {
  const { className: viewportClassName, ...viewportRest } = viewportProps
  const { className: contentClassName, ...contentRest } = contentProps

  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full overflow-x-hidden! rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          viewportClassName
        )}
        {...viewportRest}
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          className={cn("min-w-0!", contentClassName)}
          {...contentRest}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({ className, orientation = "vertical", ...props }: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "z-20 flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.Scrollbar>
  )
}
