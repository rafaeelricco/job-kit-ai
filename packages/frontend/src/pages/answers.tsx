export default AnswersPage

import { LibraryIcon, Search01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useMemo, useState } from "react"
import { comparator } from "@ui/datatable"
import { type SortState } from "@ui/datatable"
import { Input } from "@ui/input"
import { Tabs, TabsList, TabsTrigger } from "@ui/tabs"
import { AnswerTable } from "@module/profile/components/answer"
import { ProfileGate } from "@module/profile/components/profile-gate"
import { ANSWER_COLUMNS, DEFAULT_ANSWER_SORT } from "@module/profile/helpers/columns"
import { type Answer } from "@module/profile/types"
import { assertNever } from "@module/scout/result"

const SEGMENTS = ["all", "answered", "unanswered"] as const

type Segment = (typeof SEGMENTS)[number]

const isSegment = (raw: unknown): raw is Segment =>
  typeof raw === "string" && (SEGMENTS as readonly string[]).includes(raw)

function AnswersPage() {
  return (
    <ProfileGate title="Answers" Icon={LibraryIcon}>
      {(profile) => <Surface answers={profile.answers} />}
    </ProfileGate>
  )
}

const inSegment = (row: Answer, segment: Segment): boolean => {
  switch (segment) {
    case "all":
      return true
    case "answered":
      return row.answered
    case "unanswered":
      return !row.answered
    default:
      return assertNever(segment)
  }
}

// Page-local state, the way pages/dossiers.tsx holds filter and sort for its
// own surface rather than lifting it into the gate.
function Surface({ answers }: { readonly answers: readonly Answer[] }) {
  const [query, setQuery] = useState("")
  const [segment, setSegment] = useState<Segment>("all")
  const [sort, setSort] = useState<SortState>(DEFAULT_ANSWER_SORT)

  const unanswered = answers.filter((row) => !row.answered).length

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return answers.filter(
      (row) =>
        inSegment(row, segment) && (needle === "" || `${row.question} ${row.answer}`.toLowerCase().includes(needle))
    )
  }, [answers, segment, query])

  const ordered = useMemo(() => visible.slice().sort(comparator(ANSWER_COLUMNS, sort)), [visible, sort])

  const counts: Readonly<Record<Segment, number>> = {
    all: answers.length,
    answered: answers.length - unanswered,
    unanswered,
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm min-w-56">
          <HugeiconsIcon
            icon={Search01Icon}
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search questions and answers"
            aria-label="Search questions and answers"
            className="pl-8"
          />
        </div>

        <Tabs
          value={segment}
          onValueChange={(next: unknown) => {
            if (isSegment(next)) setSegment(next)
          }}
        >
          <TabsList>
            {SEGMENTS.map((id) => (
              <TabsTrigger key={id} value={id}>
                {id === "all" ?
                  "All"
                : id === "answered" ?
                  "Answered"
                : "Unanswered"}{" "}
                ({counts[id].toLocaleString()})
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* No pagination: 154 rows is one page. */}
      <AnswerTable rows={ordered} sort={sort} onSort={setSort} />

      <footer className="font-mono text-xs text-muted-foreground">
        {answers.length.toLocaleString()} answers · {unanswered.toLocaleString()} unanswered
      </footer>
    </>
  )
}
