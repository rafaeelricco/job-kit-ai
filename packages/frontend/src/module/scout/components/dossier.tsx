export { DossierCards, DossierSheet, DossierTable }

import {
  Alert02Icon,
  ArrowDown01Icon,
  Copy01Icon,
  Delete02Icon,
  Download01Icon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useState, type KeyboardEvent, type ReactNode } from "react"
import { toast } from "sonner"
import { cn } from "@components/utils"
import { Alert, AlertDescription, AlertTitle } from "@ui/alert"
import { Badge } from "@ui/badge"
import { Button } from "@ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@ui/card"
import { Checkbox } from "@ui/checkbox"
import { CopyButton } from "@ui/copy"
import { ColumnDef, DataTable } from "@ui/datatable"
import { type ColumnsConfig, type SortState } from "@ui/datatable"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@ui/dropdown-menu"
import { HoldButton } from "@ui/hold-button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@ui/sheet"
import { ScrollArea } from "@ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/table"
import { toApplyPrompt } from "@module/scout/helpers/apply-prompt"
import { type ColumnId } from "@module/scout/helpers/columns"
import { COLUMNS, DOSSIER_COLUMNS } from "@module/scout/helpers/columns"
import { toDossierText } from "@module/scout/helpers/dossier-text"
import { download, toCsv, toJson, toMarkdown } from "@module/scout/helpers/export"
import { httpHref } from "@module/scout/helpers/href"
import { bandOf } from "@module/scout/helpers/select"
import { type ScoreBand } from "@module/scout/helpers/select"
import { holdsSkill, splitSkills } from "@module/scout/helpers/skill-match"
import { assertNever } from "@module/scout/result"
import { type Dossier, type FactKey, type FactValue, type Role } from "@module/scout/types"
import { FACT_KEYS, FACT_LABELS, factText } from "@module/scout/types"

/* -- shared pieces -------------------------------------------------------- */

// One rule for the score's colour, shared with the filter: bandOf is what
// "Strong 8–10 / Keep 7 / Low ≤6" already means, so a badge and a band chip
// can never disagree. 7 stays neutral rather than amber — warning on
// warning-surface is 1.45:1, and that surface is opaque cream in dark.
const BAND_VARIANT: Readonly<Record<ScoreBand, "success" | "secondary" | "outline">> = {
  strong: "success",
  keep: "secondary",
  low: "outline",
  unscored: "outline",
}

function ScoreBadge({ score }: { readonly score: Dossier["score"] }) {
  return score.kind === "unscored" ?
      <Badge variant={BAND_VARIANT.unscored}>{factText({ kind: "unknown" })}</Badge>
    : <Badge variant={BAND_VARIANT[bandOf(score)]} className="tabular-nums">
        {score.value}
      </Badge>
}

function StatusBadges({ row }: { readonly row: Dossier }) {
  return (
    <>
      <Badge variant="secondary">{row.status}</Badge>
      {row.posting.kind === "dead" ?
        <Badge variant="destructive">dead</Badge>
      : null}
    </>
  )
}

// Eats the click so ticking a box or opening a menu never also opens the
// dossier behind it.
function StopClick({ children }: { readonly children: ReactNode }) {
  return (
    <span
      // Block-level, not inline: an inline box sits on the text baseline, and a
      // 16px checkbox in a 20px line box then rides ~4px high in a tall row.
      // `flex` takes it out of the line box so the cell's align-middle centres
      // the control itself.
      className="flex items-center"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </span>
  )
}

function SelectBox(props: {
  readonly row: Dossier
  readonly selected: boolean
  readonly onToggle: (file: string) => void
}) {
  return (
    <StopClick>
      <Checkbox
        checked={props.selected}
        onCheckedChange={() => props.onToggle(props.row.file)}
        aria-label={`Select ${props.row.company}`}
      />
    </StopClick>
  )
}

function EmptyNote() {
  return (
    <>
      <p className="text-sm font-medium text-foreground">No dossiers match</p>
      <p className="mt-1 text-sm text-muted-foreground">Clear a filter to widen the set.</p>
    </>
  )
}

/* -- table ---------------------------------------------------------------- */

type DossierTableProps = {
  readonly rows: readonly Dossier[]
  readonly columns: readonly ColumnId[]
  readonly sort: SortState
  readonly onSort: (next: SortState) => void
  readonly selected: ReadonlySet<string>
  readonly onToggle: (file: string) => void
  readonly onToggleAll: () => void
  readonly onOpen: (file: string) => void
  readonly onDelete: (file: string) => void
}

function DossierTable(props: DossierTableProps) {
  // COLUMNS drives the order so a reshuffled `columns` prop cannot scramble
  // the header/cell pairing.
  const visible = COLUMNS.filter((id) => props.columns.includes(id))
  const allSelected = props.rows.length > 0 && props.rows.every((row) => props.selected.has(row.file))

  const cell = (id: ColumnId, row: Dossier): ReactNode => {
    switch (id) {
      case "score":
        return <ScoreBadge score={row.score} />
      case "company":
        return (
          <div className="max-w-[18rem] min-w-0">
            <div className="truncate font-medium text-foreground">{row.company}</div>
            <div className="truncate text-xs text-muted-foreground">{row.title}</div>
          </div>
        )
      case "location":
        return <span className="block max-w-56 truncate">{factText(row.facts.location)}</span>
      case "salary":
        return <span className="block max-w-56 truncate">{factText(row.facts.salary)}</span>
      case "source":
        return (
          <span className="block max-w-40 truncate font-mono text-[11px] text-ink-soft">{row.provenance.source}</span>
        )
      case "status":
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadges row={row} />
          </div>
        )
      default:
        return assertNever(id)
    }
  }

  const columns = {
    select: new ColumnDef({
      className: "w-10",
      sortFun: null,
      label: (
        <Checkbox
          checked={allSelected}
          onCheckedChange={() => props.onToggleAll()}
          aria-label="Select all visible dossiers"
        />
      ),
    }),
    ...DOSSIER_COLUMNS,
    actions: new ColumnDef({
      label: "",
      sortFun: null,
      className: "w-10",
    }),
  } satisfies ColumnsConfig<Dossier>

  return (
    <DataTable
      columns={columns}
      columnOrder={["select", ...visible, "actions"]}
      sort={props.sort}
      onSortChange={props.onSort}
      emptyMessage={<EmptyNote />}
      rows={props.rows.map((row) => ({
        key: row.file,
        value: row,
        selected: props.selected.has(row.file),
        onClick: (d: Dossier) => props.onOpen(d.file),
        contents: {
          select: <SelectBox row={row} selected={props.selected.has(row.file)} onToggle={props.onToggle} />,
          score: cell("score", row),
          company: cell("company", row),
          location: cell("location", row),
          salary: cell("salary", row),
          source: cell("source", row),
          status: cell("status", row),
          actions: <RowActions row={row} onDelete={props.onDelete} />,
        },
      }))}
    />
  )
}

const DELETE_HINT = "Hold to move this file into scout/jobs/.trash — recoverable with mv"

function copyText(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error("Could not copy to the clipboard")
  )
}

function RowActions(props: { readonly row: Dossier; readonly onDelete: (file: string) => void }) {
  // Controlled so the hold can dismiss the menu itself. Releasing the pointer
  // never reaches a menu item, so nothing else would close it.
  const [open, setOpen] = useState(false)
  const { onDelete, row } = props
  const href = httpHref(row.url)
  // The export helpers take a list; one row is a list of one, and the file
  // stem names the download so a single job is not "dossiers-1.csv".
  const stem = row.file.replace(/\.md$/, "")
  const exportAs = (extension: string, mime: string, body: string) => {
    download(`${stem}.${extension}`, mime, body)
    toast.success(`Exported ${row.company}`)
  }

  return (
    <StopClick>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
          <span className="sr-only">Open menu</span>
          <HugeiconsIcon icon={MoreHorizontalIcon} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            {href === null || row.posting.kind === "dead" ? null : (
              <DropdownMenuItem onClick={() => window.open(href, "_blank", "noopener,noreferrer")}>
                <HugeiconsIcon icon={LinkSquare02Icon} />
                Open posting
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => copyText(toApplyPrompt([row]), "Apply prompt")}>
              <HugeiconsIcon icon={Copy01Icon} />
              Copy apply prompt
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <HugeiconsIcon icon={Download01Icon} />
                Export
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => exportAs("csv", "text/csv", toCsv([row]))}>CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportAs("json", "application/json", toJson([row]))}>
                  JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportAs("md", "text/markdown", toMarkdown([row]))}>
                  Markdown
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {/* The toolbar's own control, not a menu item dressed up as one: a
              DropdownMenuItem activates on click, which is the single gesture
              the hold exists to prevent. Menu items also spread their handlers
              onto whatever they render, and HoldButton installs its pointer
              handlers after the spread — the two would fight over the press. */}
          <div className="p-1">
            <HoldButton
              variant="destructive"
              size="sm"
              className="w-full justify-start"
              onHold={() => {
                setOpen(false)
                onDelete(row.file)
              }}
              title={DELETE_HINT}
              aria-label={DELETE_HINT}
            >
              <HugeiconsIcon icon={Delete02Icon} />
              Hold to delete
            </HoldButton>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </StopClick>
  )
}

/* -- cards ---------------------------------------------------------------- */

type DossierCardsProps = {
  readonly rows: readonly Dossier[]
  readonly selected: ReadonlySet<string>
  readonly onToggle: (file: string) => void
  readonly onOpen: (file: string) => void
}

function DossierCards(props: DossierCardsProps) {
  const onBodyKeyDown = (event: KeyboardEvent<HTMLDivElement>, file: string) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onOpen(file)
  }

  if (props.rows.length === 0) {
    return (
      <div className="border border-dashed border-border p-10 text-center">
        <EmptyNote />
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {props.rows.map((row) => {
        const isSelected = props.selected.has(row.file)
        return (
          <Card key={row.file} data-state={isSelected ? "selected" : undefined}>
            <CardHeader>
              <CardTitle>
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{row.company}</div>
                  <div className="truncate text-xs font-normal text-muted-foreground">{row.title}</div>
                </div>
              </CardTitle>
              <CardAction>
                <SelectBox row={row} selected={isSelected} onToggle={props.onToggle} />
              </CardAction>
            </CardHeader>
            <CardContent
              role="button"
              tabIndex={0}
              aria-label={`Open ${row.company}`}
              onClick={() => props.onOpen(row.file)}
              onKeyDown={(event) => onBodyKeyDown(event, row.file)}
              className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <ScoreBadge score={row.score} />
                <StatusBadges row={row} />
              </div>
              <dl className="mt-3 grid gap-1 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">Location</dt>
                  <dd className="truncate text-foreground">{factText(row.facts.location)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">Salary</dt>
                  <dd className="truncate text-foreground">{factText(row.facts.salary)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

/* -- sheet ---------------------------------------------------------------- */

type DossierSheetProps = {
  readonly dossier: Dossier | null
  readonly skills: readonly string[]
  readonly onClose: () => void
}

function Section(props: { readonly title: string; readonly action?: ReactNode; readonly children: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="mb-2 flex items-center justify-between gap-2 text-xs font-medium tracking-wider text-ink-muted uppercase">
        {props.title}
        {props.action}
      </h3>
      {props.children}
    </section>
  )
}

// Collapsed by default: scoring metadata and provenance are not what the sheet
// is for. `Section` is the always-open equivalent.
function Fold(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <details className="group border-b border-border last:border-b-0 open:bg-muted/40">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-xs font-medium tracking-wider text-ink-muted uppercase">
        {props.title}
        <HugeiconsIcon icon={ArrowDown01Icon} className="size-3 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-4 pb-4">{props.children}</div>
    </details>
  )
}

// Both cells are siblings so the enclosing grid owns the two columns.
function KvRow(props: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="wrap-break-words">{props.value}</dd>
    </>
  )
}

// The facts worth reading without opening a fold. An unknown value contributes
// no chip — the rule that keeps `equity —` off the screen. `satisfies` so a
// retired or misspelled key fails the build instead of rendering nothing.
const CHIP_KEYS = [
  "seniority",
  "work_model",
  "location",
  "salary",
  "equity",
  "years_experience",
] as const satisfies readonly FactKey[]

function HeaderChips({ dossier }: { readonly dossier: Dossier }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2.5">
      <ScoreBadge score={dossier.score} />
      <Badge variant="secondary">{dossier.bucket}</Badge>
      <StatusBadges row={dossier} />
      {CHIP_KEYS.filter((key) => dossier.facts[key].kind === "known").map((key) => (
        <Badge key={key} variant="outline" className="text-muted-foreground">
          {factText(dossier.facts[key])}
        </Badge>
      ))}
      {/* badge.tsx's destructive variant is already the soft bg-destructive/10
          tint the design calls for, not a solid fill. */}
      {dossier.facts.blocker.kind === "known" && <Badge variant="destructive">{factText(dossier.facts.blocker)}</Badge>}
    </div>
  )
}

// One shared look for "the profile holds this", so the Stack chip and the
// Must have counter cannot drift apart. A plain ✓ rather than a lucide icon:
// the stroked glyph reads heavier than the rest of the chip text.
function HeldBadge({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-ok/45 text-ok", className)}>
      ✓ {children}
    </Badge>
  )
}

// Required skills as scannable tokens, each marked against the profile. No
// data/skills.yaml → `skills` is empty and every token renders plain rather
// than falsely unheld.
function StackChips({ value, skills }: { readonly value: FactValue; readonly skills: readonly string[] }) {
  if (value.kind === "unknown") return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {splitSkills(value.text).map((skill) =>
        skills.length > 0 && holdsSkill(skills, skill) ?
          <HeldBadge key={skill}>{skill}</HeldBadge>
        : <Badge key={skill} variant="outline" className="text-muted-foreground opacity-70">
            {skill}
          </Badge>
      )}
    </div>
  )
}

const namesSkill = (line: string, skill: string): boolean => {
  const at = line.toLowerCase().indexOf(skill.toLowerCase())
  if (at === -1) return false
  const before = at === 0 ? "" : line.charAt(at - 1)
  const after = line.charAt(at + skill.length)
  return !/[a-z0-9+.#]/i.test(before) && !/[a-z0-9+.#]/i.test(after)
}

// A requirement line counts as matched when it names a skill the profile holds.
// Prose like "comfort operating with ambiguity" names none, and should not count.
const matchedRequirements = (requirements: readonly string[], skills: readonly string[]): number =>
  requirements.filter((line) => skills.some((skill) => namesSkill(line, skill))).length

function Bullets({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-4 text-sm">
      {items.map((item, index) => (
        <li key={`${String(index)}-${item.slice(0, 24)}`}>{item}</li>
      ))}
    </ul>
  )
}

const isEmptyRole = (role: Role): boolean =>
  role.snapshot === "" && role.responsibilities.length === 0 && role.requirements.length === 0

function DossierSheet(props: DossierSheetProps) {
  const { dossier, skills, onClose } = props

  return (
    <Sheet
      open={dossier !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent className="gap-0 p-0 data-[side=right]:sm:max-w-xl">
        {dossier !== null && (
          <>
            <SheetHeader className="shrink-0 gap-1 border-b border-border px-4 py-4 pr-12">
              <SheetTitle>{dossier.company}</SheetTitle>
              <SheetDescription>{dossier.title}</SheetDescription>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1.5 text-xs text-muted-foreground">
                {httpHref(dossier.url) === null ?
                  <span className="font-mono text-[11px] break-all text-ink-soft">{dossier.url}</span>
                : <a
                    href={dossier.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    <HugeiconsIcon icon={LinkSquare02Icon} className="size-3.5" />
                    Open posting
                  </a>
                }
                {/* Same line as the posting link: both act on the posting, and
                    a row of its own held a single button. */}
                <CopyButton
                  value={() => toDossierText(dossier)}
                  label="Copy dossier"
                  variant="link"
                  className="h-auto p-0 text-xs text-foreground"
                />
                <CopyButton
                  value={() => toApplyPrompt([dossier])}
                  label="Copy apply prompt"
                  variant="link"
                  className="h-auto p-0 text-xs text-foreground"
                />
              </div>
              <HeaderChips dossier={dossier} />
            </SheetHeader>

            <ScrollArea className="min-h-0 min-w-0 flex-1">
              {dossier.posting.kind === "dead" && (
                <div className="px-4 pt-4">
                  <Alert variant="destructive">
                    <HugeiconsIcon icon={Alert02Icon} />
                    <AlertTitle>Posting marked dead</AlertTitle>
                    <AlertDescription>This posting was marked dead since {dossier.posting.since}.</AlertDescription>
                  </Alert>
                </div>
              )}

              {dossier.role.snapshot !== "" && (
                <Section title="The role">
                  <p className="text-sm">{dossier.role.snapshot}</p>
                </Section>
              )}

              {dossier.role.responsibilities.length > 0 && (
                <Section title="What you'd do">
                  <Bullets items={dossier.role.responsibilities} />
                </Section>
              )}

              {dossier.role.requirements.length > 0 && (
                <Section
                  title="Must have"
                  action={
                    skills.length > 0 && (
                      <HeldBadge className="font-normal tracking-normal normal-case">
                        {matchedRequirements(dossier.role.requirements, skills)} of {dossier.role.requirements.length}{" "}
                        match
                      </HeldBadge>
                    )
                  }
                >
                  <Bullets items={dossier.role.requirements} />
                </Section>
              )}

              {dossier.facts.required_skills.kind === "known" && (
                <Section title="Stack">
                  <StackChips value={dossier.facts.required_skills} skills={skills} />
                </Section>
              )}

              {/* Legacy: a dossier written before scout wrote roles keeps its
                  excerpt, so the ones already on disk lose nothing until they
                  are next scouted. New dossiers never reach this branch. */}
              {isEmptyRole(dossier.role) && dossier.excerpt.kind === "printed" && (
                <Section title="From the posting">
                  <blockquote className="border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-muted-foreground">
                    {dossier.excerpt.text}
                  </blockquote>
                </Section>
              )}

              <Fold title="Score">
                <Table className="text-sm">
                  <TableBody>
                    {dossier.verdict.factors.map((factor, index) => (
                      <TableRow key={`${String(index)}-${factor.label}`}>
                        {/* The label is scout's, and its spelling varies between files —
                            lift the first letter only rather than invent a mapping. */}
                        <TableCell className="w-36 px-1.5 py-1.5 text-muted-foreground first-letter:uppercase">
                          {factor.label}
                        </TableCell>
                        {/* A factor with no evidence scored nothing, which is not the
                            same as scoring zero — it is named rather than dashed, so
                            the column of numerals is never read as one. */}
                        <TableCell
                          className={cn(
                            "px-1.5 py-1.5 text-right tabular-nums",
                            factor.points.kind === "unknown" && "text-muted-foreground"
                          )}
                        >
                          {factor.points.kind === "unknown" ? "no signal" : factText(factor.points)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell className="w-36 px-1.5 py-1.5 font-medium">Total</TableCell>
                      {/* The fold's total is the same number as the header
                          badge; colouring one and not the other reads as two
                          different scores. */}
                      <TableCell
                        className={cn(
                          "px-1.5 py-1.5 text-right font-medium tabular-nums",
                          bandOf(dossier.score) === "strong" && "text-success-strong"
                        )}
                      >
                        {dossier.score.kind === "scored" ? String(dossier.score.value) : factText({ kind: "unknown" })}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </Fold>

              <Fold title="Facts">
                <Table className="text-[0.82rem]">
                  <TableBody>
                    {FACT_KEYS.filter((key) => dossier.facts[key].kind === "known").map((key) => (
                      <TableRow key={key}>
                        <TableCell className="w-36 px-1.5 py-1.5 align-top text-muted-foreground">
                          {FACT_LABELS[key]}
                        </TableCell>
                        <TableCell className="px-1.5 py-1.5 align-top whitespace-normal">
                          {factText(dossier.facts[key])}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Fold>

              <Fold title="Logs">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-sm">
                  <KvRow label="Source" value={dossier.provenance.source} />
                  {dossier.provenance.author.kind === "known" && (
                    <KvRow label="Author" value={factText(dossier.provenance.author)} />
                  )}
                  {dossier.provenance.contact.kind === "known" && (
                    <KvRow label="Contact" value={factText(dossier.provenance.contact)} />
                  )}
                  {dossier.provenance.matchedQuery.kind === "known" && (
                    <KvRow label="Pack query" value={factText(dossier.provenance.matchedQuery)} />
                  )}
                  {/* Free text in the corpus — printed exactly as written. */}
                  <KvRow label="Search date" value={dossier.provenance.date} />
                </dl>

                {dossier.log.length === 0 ?
                  <p className="mt-3 text-sm text-muted-foreground">No entries</p>
                : <Table className="mt-3 text-[0.82rem]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-28 px-1.5">Date</TableHead>
                        <TableHead className="px-1.5">Event</TableHead>
                        <TableHead className="w-32 px-1.5">Writer</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dossier.log.map((entry, index) => (
                        <TableRow key={`${String(index)}-${entry.date}`}>
                          <TableCell className="px-1.5 py-1.5 align-top font-mono text-[11px] text-ink-soft">
                            {entry.date}
                          </TableCell>
                          <TableCell className="px-1.5 py-1.5 align-top whitespace-normal">{entry.event}</TableCell>
                          <TableCell className="px-1.5 py-1.5 align-top text-muted-foreground">
                            {entry.writer}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                }
                {dossier.applications > 0 && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {dossier.applications.toLocaleString()} application record
                    {dossier.applications === 1 ? "" : "s"} live below the log in the file itself and are not parsed
                    here.
                  </p>
                )}
              </Fold>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
