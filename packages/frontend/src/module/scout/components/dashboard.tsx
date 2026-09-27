export { Dashboard }

import { useMemo, useState } from "react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { type ReactNode } from "react"
import {
  Activity01Icon,
  AnalyticsUpIcon,
  Calendar02Icon,
  GitBranchIcon,
  GlobeIcon,
  Layers01Icon,
  MailSend01Icon,
  StarIcon,
  Target01Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons"
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"
import { Card, CardContent } from "@ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@ui/chart"
import { type ChartConfig } from "@ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select"
import {
  RANGES,
  anchorOf,
  appliedDates,
  deltaPct,
  foundDates,
  isHighScore,
  isLive,
  pairedSeries,
  seriesOf,
  sourceSeries,
  tallyAppliedBySource,
  tallyBy,
  windowOf,
} from "@module/scout/helpers/analytics"
import { type PairedPoint, type RangeKey, type TallyRow, type Window } from "@module/scout/helpers/analytics"
import { CHANNELS, LIFECYCLES } from "@module/scout/types"
import { type Channel, type Dossier } from "@module/scout/types"

const ALL_CHANNELS = "all"

const CHANNEL_LABELS: Record<Channel, string> = {
  direct_email: "Direct email",
  dm_request: "DM request",
  founder: "Founder",
  ats: "ATS",
}

const TILES = [
  { key: "high", label: "Score 8+", Icon: StarIcon, pick: isHighScore },
  {
    key: "ready",
    label: "Ready to apply",
    Icon: Target01Icon,
    pick: (d: Dossier) => d.status === "new" && isHighScore(d) && isLive(d),
  },
  {
    key: "play",
    label: "In play",
    Icon: Activity01Icon,
    pick: (d: Dossier) => d.status === "applied" || d.status === "interview" || d.status === "offer",
  },
] as const

const CHART: ChartConfig = {
  count: { label: "This period", color: "var(--color-brand)" },
  prior: { label: "Previous", color: "var(--color-brand)" },
}

// The reference separates its series with shades of one hue, not a rainbow, and
// this palette is a single brand blue over neutrals — `--chart-1..5` are all
// zero-chroma. Mixing toward theme tokens keeps the ramp readable in both
// themes. The last shade is grey, reserved for the folded "other" bucket.
const SOURCE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

const SOURCE_LIMIT = SOURCE_COLORS.length - 1

const colorOf = (index: number) => SOURCE_COLORS[index] ?? "var(--color-muted-foreground)"

// Source ids are their own labels and the strokes come from SOURCE_COLORS, so
// the container needs no config entries — and none get emitted as CSS vars.
const SOURCE_CHART: ChartConfig = {}

function Dashboard({ dossiers }: { readonly dossiers: readonly Dossier[] }) {
  const [range, setRange] = useState<RangeKey>("30d")
  const [compare, setCompare] = useState(true)
  const [channel, setChannel] = useState<Channel | typeof ALL_CHANNELS>(ALL_CHANNELS)

  const scoped = useMemo(
    () => (channel === ALL_CHANNELS ? dossiers : dossiers.filter((d) => d.channel === channel)),
    [dossiers, channel]
  )

  const days = RANGES.find((r) => r.key === range)?.days ?? null
  const anchor = useMemo(() => anchorOf(dossiers), [dossiers])
  const current = useMemo(() => windowOf(anchor, days), [anchor, days])
  const previous = useMemo(() => windowOf(anchor, days, 1), [anchor, days])
  // "All time" has nothing behind it to compare against.
  const baseline = compare && days !== null ? previous : null

  const trend = useMemo(() => pairedSeries(scoped, current, baseline, foundDates), [scoped, current, baseline])
  const applications = useMemo(() => pairedSeries(scoped, current, baseline, appliedDates), [scoped, current, baseline])
  const sources = useMemo(() => sourceSeries(scoped, current, SOURCE_LIMIT), [scoped, current])
  const pipeline = useMemo(() => tallyBy(scoped, current, LIFECYCLES, (d) => d.status), [scoped, current])
  const appliedBySource = useMemo(() => tallyAppliedBySource(scoped, current), [scoped, current])
  const total = trend.reduce((n, p) => n + p.count, 0)
  const appliedTotal = applications.reduce((n, p) => n + p.count, 0)

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Pill
          Icon={Calendar02Icon}
          value={range}
          onValue={(v) => setRange(v as RangeKey)}
          options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
        />
        <Pill
          Icon={Calendar02Icon}
          value={compare ? "on" : "off"}
          onValue={(v) => setCompare(v === "on")}
          options={[
            { value: "on", label: "Compare" },
            { value: "off", label: "No comparison" },
          ]}
        />
        <Pill
          Icon={Layers01Icon}
          value={channel}
          onValue={(v) => setChannel(v as Channel | typeof ALL_CHANNELS)}
          options={[
            { value: ALL_CHANNELS, label: "All channels" },
            ...CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
          ]}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {TILES.map((tile) => (
          <Tile
            key={tile.key}
            label={tile.label}
            Icon={tile.Icon}
            points={seriesOf(scoped, current, tile.pick)}
            delta={baseline === null ? null : deltaPct(scoped, current, baseline, tile.pick)}
          />
        ))}
      </div>

      <TrendCard
        title="Dossiers over time"
        Icon={AnalyticsUpIcon}
        points={trend}
        current={current}
        baseline={baseline}
      />

      <Card>
        <CardContent className="flex flex-col gap-4">
          <SectionTitle Icon={GlobeIcon}>Sources over time</SectionTitle>

          {sources.rows.length === 0 ?
            <p className="text-sm text-muted-foreground">No dossiers in this range.</p>
          : <>
              <ChartContainer config={SOURCE_CHART} className="h-64 w-full">
                <LineChart data={[...sources.points]} margin={{ left: -16, right: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="0" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={12}
                    minTickGap={40}
                    tickFormatter={shortDate}
                  />
                  <YAxis tickLine={false} axisLine={false} tickMargin={12} allowDecimals={false} width={48} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(label) => (typeof label === "string" ? shortDate(label) : label)}
                      />
                    }
                  />
                  {sources.rows.map((row, index) => (
                    <Line
                      key={row.label}
                      dataKey={row.label}
                      type="monotone"
                      stroke={colorOf(index)}
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ChartContainer>

              <div className="flex flex-wrap items-center justify-center gap-6">
                {sources.rows.map((row, index) => (
                  <Key key={row.label} label={row.label} color={colorOf(index)} count={row.count} />
                ))}
              </div>
            </>
          }
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <TrendCard
          title="Applications over time"
          Icon={MailSend01Icon}
          points={applications}
          current={current}
          baseline={baseline}
        />
        <BarList title="Pipeline" Icon={GitBranchIcon} rows={pipeline} total={total} />
      </div>

      <BarList
        title="Applications by source"
        Icon={GlobeIcon}
        rows={appliedBySource}
        total={appliedTotal}
        empty="No applications in this range."
      />
    </>
  )
}

// The reference underlines every section heading with a dotted rule that spans
// the icon and the text, and never shouts it in uppercase.
function SectionTitle({ Icon, children }: { readonly Icon: IconSvgElement; readonly children: ReactNode }) {
  return (
    <div className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
      <HugeiconsIcon icon={Icon} className="size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}

function Key({ label, color, count }: { readonly label: string; readonly color: string; readonly count?: number }) {
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {label}
      {count === undefined ? null : <span className="text-foreground tabular-nums">{count.toLocaleString()}</span>}
    </span>
  )
}

// Two panels want the same card: a heading, the range total in 28px, a compare
// line under it. The only differences are the title, the icon, and the series.
function TrendCard({
  title,
  Icon,
  points,
  current,
  baseline,
}: {
  readonly title: string
  readonly Icon: IconSvgElement
  readonly points: readonly PairedPoint[]
  readonly current: Window
  readonly baseline: Window | null
}) {
  const total = points.reduce((n, p) => n + p.count, 0)

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <SectionTitle Icon={Icon}>{title}</SectionTitle>
          <p className="text-2xl leading-none font-semibold tabular-nums">{total.toLocaleString()}</p>
        </div>

        <ChartContainer config={CHART} className="h-64 w-full">
          <LineChart data={[...points]} margin={{ left: -16, right: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="0" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={12}
              minTickGap={40}
              tickFormatter={shortDate}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={12} allowDecimals={false} width={48} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => (typeof label === "string" ? shortDate(label) : label)}
                  formatter={(value, name, item) => {
                    const isPrior = name === "prior"
                    const priorDate =
                      isPrior && typeof item.payload?.priorDate === "string" ?
                        ` · ${shortDate(item.payload.priorDate)}`
                      : ""
                    return (
                      <div className="flex w-full items-center gap-2">
                        <div className="size-2.5 shrink-0" style={{ backgroundColor: item.color }} />
                        <span className="flex-1 text-muted-foreground">
                          {isPrior ? "Previous" : "This period"}
                          {priorDate}
                        </span>
                        <span className="font-mono font-medium text-foreground tabular-nums">
                          {typeof value === "number" ? value.toLocaleString() : String(value)}
                        </span>
                      </div>
                    )
                  }}
                />
              }
            />
            {baseline === null ? null : (
              <Line
                dataKey="prior"
                type="monotone"
                stroke="var(--color-prior)"
                strokeWidth={1.5}
                strokeDasharray="2 3"
                strokeOpacity={0.55}
                dot={false}
                isAnimationActive={false}
              />
            )}
            <Line
              dataKey="count"
              type="monotone"
              stroke="var(--color-count)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>

        <div className="flex flex-wrap items-center justify-center gap-6">
          <Key label={rangeLabel(current)} color="var(--color-brand)" />
          {baseline === null ? null : (
            <Key label={rangeLabel(baseline)} color="color-mix(in oklab, var(--color-brand) 50%, var(--color-card))" />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function Pill({
  Icon,
  value,
  onValue,
  options,
}: {
  readonly Icon: IconSvgElement
  readonly value: string
  readonly onValue: (value: string) => void
  readonly options: readonly { value: string; label: string }[]
}) {
  // Base UI reads labels for the trigger off `items`, not off the children.
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]))

  return (
    <Select items={items} value={value} onValueChange={(v) => onValue(String(v))}>
      <SelectTrigger
        className="h-9 w-auto gap-2 border-border bg-card px-3 text-sm"
        icon={<HugeiconsIcon icon={UnfoldMoreIcon} className="pointer-events-none size-3.5 text-muted-foreground" />}
      >
        <HugeiconsIcon icon={Icon} className="size-4 text-muted-foreground" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Tile({
  label,
  Icon,
  points,
  delta,
}: {
  readonly label: string
  readonly Icon: IconSvgElement
  readonly points: readonly { date: string; count: number }[]
  readonly delta: number | null
}) {
  const total = points.reduce((n, p) => n + p.count, 0)

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <SectionTitle Icon={Icon}>{label}</SectionTitle>
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl leading-none font-semibold tabular-nums">{total.toLocaleString()}</span>
            {delta === null ? null : (
              <span
                className={
                  delta < 0 ?
                    "text-xs font-medium text-danger tabular-nums"
                  : "text-xs font-medium text-success tabular-nums"
                }
              >
                {delta > 0 ? "+" : ""}
                {delta}%
              </span>
            )}
          </div>
          <Sparkline points={points} />
        </div>
      </CardContent>
    </Card>
  )
}

function Sparkline({ points }: { readonly points: readonly { date: string; count: number }[] }) {
  // One bar per day gets unreadable past a week, so long ranges bucket down.
  const bars = bucket(
    points.map((p) => p.count),
    7
  )
  const peak = Math.max(...bars, 1)

  return (
    <div className="flex h-9 items-end gap-1" aria-hidden="true">
      {bars.map((value, index) => (
        <span
          key={index}
          className="w-2 bg-ink-faint/30"
          style={{ height: `${Math.max((value / peak) * 100, 10)}%` }}
        />
      ))}
    </div>
  )
}

function bucket(values: readonly number[], into: number): number[] {
  if (values.length <= into) return [...values]

  const size = Math.ceil(values.length / into)
  const out: number[] = []
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size).reduce((n, v) => n + v, 0))
  }
  return out
}

function BarList({
  title,
  Icon,
  rows,
  total,
  empty = "No dossiers in this range.",
}: {
  readonly title: string
  readonly Icon: IconSvgElement
  readonly rows: readonly TallyRow[]
  readonly total: number
  readonly empty?: string
}) {
  const peak = Math.max(...rows.map((r) => r.count), 1)

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <SectionTitle Icon={Icon}>{title}</SectionTitle>

        {rows.length === 0 ?
          <p className="text-sm text-muted-foreground">{empty}</p>
        : <ul className="flex flex-col gap-4">
            {rows.map((row) => (
              <li key={row.label} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-3">
                  <span className="flex-1 truncate font-mono text-[11px] text-ink-soft">{row.label}</span>
                  <span className="w-14 text-right text-sm text-muted-foreground tabular-nums">
                    {total === 0 ? "—" : `${Math.round((row.count / total) * 100)}%`}
                  </span>
                  <span className="w-10 text-right text-sm tabular-nums">{row.count.toLocaleString()}</span>
                </div>
                <div className="h-2.5 bg-muted">
                  <div className="h-full bg-chart-1" style={{ width: `${(row.count / peak) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        }
      </CardContent>
    </Card>
  )
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

function rangeLabel(w: Window): string {
  return w.from === "0000-01-01" ? `Through ${longDate(w.to)}` : `${shortDate(w.from)} – ${longDate(w.to)}`
}
