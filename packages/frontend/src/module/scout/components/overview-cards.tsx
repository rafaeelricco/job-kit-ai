export { OverviewCards, type OverviewCardsProps }

import { CheckmarkCircle01Icon, Files01Icon, RadioIcon, StarIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { Card, CardContent } from "@ui/card"

type OverviewCardsProps = {
  readonly summary: {
    readonly total: number
    readonly highScore: number
    readonly applied: number
    readonly live: number
  }
}

type Tile = {
  readonly label: string
  readonly value: number
  readonly Icon: IconSvgElement
}

// Read-only display. No handlers, no links, nothing focusable — a tile that
// looks pressable but does nothing is worse than a tile that looks inert.
function OverviewCards(props: OverviewCardsProps) {
  const { summary } = props
  const tiles: readonly Tile[] = [
    { label: "Total dossiers", value: summary.total, Icon: Files01Icon },
    { label: "Score 8+", value: summary.highScore, Icon: StarIcon },
    { label: "Applied", value: summary.applied, Icon: CheckmarkCircle01Icon },
    { label: "Live postings", value: summary.live, Icon: RadioIcon },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Card key={tile.label}>
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              <HugeiconsIcon icon={tile.Icon} className="size-4" aria-hidden="true" />
              <span>{tile.label}</span>
            </div>
            <span className="text-2xl font-semibold text-foreground tabular-nums">{tile.value.toLocaleString()}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
