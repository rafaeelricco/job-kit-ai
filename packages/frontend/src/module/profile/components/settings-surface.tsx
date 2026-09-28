// eslint-disable-next-line react-refresh/only-export-components -- the dialog reads the panel registry and its parser from the module that renders them, so the two can never drift apart.
export { PANELS, PANEL_ORDER, SettingsPanel, parsePanel, type PanelId }

import {
  AiBrain01Icon,
  ComputerIcon,
  Copy01Icon,
  FilterIcon,
  Layers01Icon,
  Link02Icon,
  Location01Icon,
  Moon02Icon,
  SearchList01Icon,
  Sun01Icon,
  Tick02Icon,
  TranslateIcon,
  UserIcon,
} from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"
import { HugeiconsIcon } from "@hugeicons/react"
import type { ComponentProps, ReactNode } from "react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useTheme } from "@components/ui/theme-provider"
import type { Theme } from "@components/ui/theme-provider"
import { Alert, AlertDescription } from "@ui/alert"
import { Button } from "@ui/button"
import { FieldGroup, FieldLegend, FieldSet } from "@ui/field"
import { CheckboxInput, FormInput, SelectInput, TextareaInput, TextInput, useForm, type FormOutputs } from "@ui/forms"
import { Label } from "@ui/label"
import { Failed, Loading, NotAsked, Ready, type RemoteData } from "@lib/remote-data"
import { cn } from "@components/utils"
import { describeSaveError } from "@module/profile/helpers/describe-save-error"
import type { Save } from "@module/profile/helpers/use-profile"
import type { Edit, SaveError } from "@module/profile/helpers/write-profile"
import type { Basics, JobSearch, Language, Profile, SearchPack, SocialProfile, Toggle } from "@module/profile/types"
import { assertNever } from "@module/scout/result"

type PanelId = "profile" | "ai" | "basics" | "profiles" | "languages" | "search" | "filters" | "packs"

// One section per YAML file, plus AI (server-held, so no file caption), except basics.yaml (identity facts vs. contact
// facts) and job_search.yaml (what scout looks for vs. what it drops). Both
// halves write disjoint keys and only one panel is ever mounted, so two forms
// on one file never race. `file` is the caption the dialog header prints.
const PANELS: Readonly<
  Record<PanelId, { readonly label: string; readonly file: string | null; readonly Icon: IconSvgElement }>
> = {
  profile: { label: "Profile", file: "basics.yaml", Icon: UserIcon },
  ai: { label: "AI", file: null, Icon: AiBrain01Icon },
  basics: { label: "Basics", file: "basics.yaml", Icon: Location01Icon },
  profiles: { label: "Profiles", file: "profiles.yaml", Icon: Link02Icon },
  languages: { label: "Languages", file: "languages.yaml", Icon: TranslateIcon },
  search: { label: "Search", file: "job_search.yaml", Icon: SearchList01Icon },
  filters: { label: "Filters", file: "job_search.yaml", Icon: FilterIcon },
  packs: { label: "Packs", file: "search_packs.yaml", Icon: Layers01Icon },
}

const PANEL_ORDER: readonly PanelId[] = [
  "profile",
  "ai",
  "basics",
  "profiles",
  "languages",
  "search",
  "filters",
  "packs",
]

const isPanelId = (value: string): value is PanelId => Object.hasOwn(PANELS, value)

// An unknown or empty value is a bare `?settings`, not an error: it opens the
// first panel rather than blanking the dialog.
const parsePanel = (value: string): PanelId => (isPanelId(value) ? value : "profile")

const THEMES = [
  { value: "light", label: "Light", Icon: Sun01Icon },
  { value: "dark", label: "Dark", Icon: Moon02Icon },
  { value: "system", label: "System", Icon: ComputerIcon },
] as const

type Path = readonly (string | number)[]

const toLines = (values: readonly string[]): string => values.join("\n")

// A blank line is spacing the user typed, not a list entry, so it never reaches
// the file.
const fromLines = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")

const sameList = (next: readonly string[], before: readonly string[]): boolean =>
  next.length === before.length && next.every((value, index) => value === before[index])

// An edit is emitted only for a field the user actually moved, so a save
// rewrites those scalars and leaves every other line of the file as it was.
const changed = (path: Path, next: string, before: string): readonly Edit[] =>
  next === before ? [] : [{ op: "set", path, value: next }]

const humanize = (key: string): string => key.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase())

// Each card owns its own save: one file, one RemoteData cell. Saving Identity's
// basics never writes profiles.yaml, so a failure is scoped to the card that
// caused it. Success remounts the card (SettingsPanel keys it on the file's
// stamp), so Ready only shows until the reload lands.
function useCardSave(
  file: string,
  save: Save
): { readonly submit: RemoteData<SaveError, void>; readonly run: (edits: readonly Edit[]) => void } {
  const [submit, setSubmit] = useState<RemoteData<SaveError, void>>(NotAsked())

  const run = (edits: readonly Edit[]): void => {
    if (submit.isLoading) return
    setSubmit(Loading())
    save(file, edits).fork(
      (error) => setSubmit(Failed(error)),
      () => {
        setSubmit(Ready(undefined))
        toast.success(`Saved data/${file}`)
      }
    )
  }

  return { submit, run }
}

function SaveButton({
  submit,
  dirty,
  onReset,
}: {
  readonly submit: RemoteData<SaveError, void>
  readonly dirty: boolean
  readonly onReset: () => void
}) {
  return (
    <div className="space-y-2">
      {submit instanceof Failed ?
        <Alert variant="destructive">
          <AlertDescription>{describeSaveError(submit.error)}</AlertDescription>
        </Alert>
      : null}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" className="h-8 px-3" disabled={submit.isLoading || !dirty}>
          {submit.isLoading ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 border-divider-emphasis bg-transparent px-3 text-ink-soft"
          disabled={submit.isLoading || !dirty}
          onClick={onReset}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}

// Rows read from the profile key their fields by row id, so a lookup is typed as
// possibly missing; every key asked for is one the same card put in its config.
function RowInput({
  config,
  disabled,
  className,
}: {
  readonly config: ComponentProps<typeof FormInput>["config"] | undefined
  readonly disabled: boolean
  readonly className?: string
}) {
  return config === undefined ? null : <FormInput config={config} className={className} disabled={disabled} />
}

const listInput = (label: string, hint: string, values: readonly string[]): TextareaInput =>
  new TextareaInput({ label, description: `${hint} One entry per line.`, defaultValue: toLines(values), rows: 4 })

// Object.fromEntries widens keys to string; every row contributes its own
// `field`, so the record is total.
function listFields<Name extends string>(
  rows: readonly ListRow<Name>[],
  values: Readonly<Record<Name, readonly string[]>>
): Record<Name, TextareaInput> {
  return Object.fromEntries(
    rows.map((row) => [row.field, listInput(row.label, row.hint, values[row.field])])
  ) as Record<Name, TextareaInput>
}

// The console's non-input readout: a 12px label over arbitrary content, used
// where there is no control to point an htmlFor at.
function Block({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs leading-none font-normal text-ink-soft">{label}</Label>
      {children}
    </div>
  )
}

type BasicsRow = {
  readonly field: keyof Basics
  readonly label: string
  readonly path: Path
  readonly hint?: string
}

// Split across two panels: who you are, then how to reach you. Disjoint key
// sets, so the two forms never write the same line of basics.yaml.
const PROFILE_ROWS: readonly BasicsRow[] = [
  { field: "name", label: "Display name", path: ["name"], hint: "First and last split at the first space." },
  { field: "email", label: "Email", path: ["email"] },
]

const BASICS_ROWS: readonly BasicsRow[] = [
  { field: "phone", label: "Phone", path: ["phone"] },
  { field: "location", label: "Location", path: ["location"], hint: "City, region, country as printed." },
  { field: "country", label: "Country", path: ["country"], hint: "Country of residence as a form lists it." },
  { field: "urlLabel", label: "Site label", path: ["url", "label"] },
  { field: "urlHref", label: "Site URL", path: ["url", "href"] },
]

// One form over an explicit row list, so Profile and Basics share it and each
// emits edits for its own keys only.
function BasicsForm({
  rows,
  basics,
  save,
}: {
  readonly rows: readonly BasicsRow[]
  readonly basics: Basics
  readonly save: Save
}) {
  const { submit, run } = useCardSave("basics.yaml", save)
  const config: Record<string, TextInput> = Object.fromEntries(
    rows.map((row) => [
      row.field,
      new TextInput({ label: row.label, type: "text", defaultValue: basics[row.field], description: row.hint }),
    ])
  )
  const { fields, values, onSubmit, reset } = useForm({ fields: config })

  const toEdits = (v: FormOutputs<typeof config>): readonly Edit[] =>
    rows.flatMap<Edit>((row) => changed(row.path, v[row.field] ?? basics[row.field], basics[row.field]))
  const handleSave = onSubmit((v) => run(toEdits(v)))

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSave()
      }}
    >
      <FieldGroup>
        {rows.map((row) => (
          <RowInput key={row.field} config={fields[row.field]} className="max-w-sm" disabled={submit.isLoading} />
        ))}
      </FieldGroup>
      <SaveButton submit={submit} dirty={toEdits(values).length > 0} onReset={reset} />
    </form>
  )
}

function BasicsSection({ basics, save }: { readonly basics: Basics; readonly save: Save }) {
  return <BasicsForm rows={BASICS_ROWS} basics={basics} save={save} />
}

const socialKey = (id: string, part: "username" | "url"): string => `${id}:${part}`
const socialHeading = (row: SocialProfile): string => (row.network === "" ? `Profile ${row.id}` : row.network)

function SocialsSection({ socials, save }: { readonly socials: readonly SocialProfile[]; readonly save: Save }) {
  const { submit, run } = useCardSave("profiles.yaml", save)
  // The visible name is the legend; the hidden label names the network too, or
  // three rows read alike.
  const config: Record<string, TextInput> = Object.fromEntries(
    socials.flatMap((row): [string, TextInput][] => [
      [
        socialKey(row.id, "username"),
        new TextInput({
          label: `${socialHeading(row)} username`,
          hideLabel: true,
          type: "text",
          defaultValue: row.username,
        }),
      ],
      [
        socialKey(row.id, "url"),
        new TextInput({ label: `${socialHeading(row)} URL`, hideLabel: true, type: "text", defaultValue: row.url }),
      ],
    ])
  )
  const { fields, values, onSubmit, reset } = useForm({ fields: config })

  // `row.id` is the row's place in the file, which is what an edit path
  // addresses; username-less rows were dropped before this list was built.
  // The network name is a heading, so no edit targets `row.key`.
  const toEdits = (v: FormOutputs<typeof config>): readonly Edit[] =>
    socials.flatMap<Edit>((row) => {
      const index = Number(row.id)
      return [
        ...changed(["profiles", index, "username"], v[socialKey(row.id, "username")] ?? row.username, row.username),
        ...changed(["profiles", index, "url"], v[socialKey(row.id, "url")] ?? row.url, row.url),
      ]
    })
  const handleSave = onSubmit((v) => run(toEdits(v)))

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSave()
      }}
    >
      <FieldGroup>
        {socials.map((row) => (
          <FieldSet key={row.id}>
            <FieldLegend variant="label">{socialHeading(row)}</FieldLegend>
            <div className="grid gap-4 sm:grid-cols-2">
              <RowInput config={fields[socialKey(row.id, "username")]} disabled={submit.isLoading} />
              <RowInput config={fields[socialKey(row.id, "url")]} disabled={submit.isLoading} />
            </div>
          </FieldSet>
        ))}
      </FieldGroup>
      <SaveButton submit={submit} dirty={toEdits(values).length > 0} onReset={reset} />
    </form>
  )
}

function LanguagesSection({ languages, save }: { readonly languages: readonly Language[]; readonly save: Save }) {
  const { submit, run } = useCardSave("languages.yaml", save)
  const config: Record<string, TextInput> = Object.fromEntries(
    languages.flatMap((row): [string, TextInput][] => [
      [`${row.id}:name`, new TextInput({ label: "Language", type: "text", defaultValue: row.name })],
      [`${row.id}:level`, new TextInput({ label: "Level", type: "text", defaultValue: row.level })],
    ])
  )
  const { fields, values, onSubmit, reset } = useForm({ fields: config })

  const toEdits = (v: FormOutputs<typeof config>): readonly Edit[] =>
    languages.flatMap<Edit>((row) => {
      const index = Number(row.id)
      return [
        ...changed(["languages", index, "name"], v[`${row.id}:name`] ?? row.name, row.name),
        ...changed(["languages", index, "level"], v[`${row.id}:level`] ?? row.level, row.level),
      ]
    })
  const handleSave = onSubmit((v) => run(toEdits(v)))

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSave()
      }}
    >
      <FieldGroup>
        {languages.map((row) => (
          <div key={row.id} className="grid gap-4 sm:grid-cols-2">
            <RowInput config={fields[`${row.id}:name`]} disabled={submit.isLoading} />
            <RowInput config={fields[`${row.id}:level`]} disabled={submit.isLoading} />
          </div>
        ))}
      </FieldGroup>
      <SaveButton submit={submit} dirty={toEdits(values).length > 0} onReset={reset} />
    </form>
  )
}

type ToggleGroupName = "workModel" | "jobTypes"

const TOGGLE_GROUPS: readonly {
  readonly field: ToggleGroupName
  readonly label: string
  readonly key: string
}[] = [
  { field: "workModel", label: "Work model", key: "work_model" },
  { field: "jobTypes", label: "Job types", key: "job_types" },
]

type SearchListName = "positions" | "locations"

type FilterListName = "excludeLocations" | "excludeCompanies" | "directRegions" | "marketCurrencies"

// location_scope's vocabulary, empty included: an incomplete profile is a gap
// scout names, where an unknown value silently matches no search branch.
const SCOPES: readonly string[] = ["", "worldwide", "listed"]

type ListRow<Name extends string> = {
  readonly field: Name
  readonly label: string
  readonly path: Path
  readonly hint: string
}

const SEARCH_LIST_ROWS: readonly ListRow<SearchListName>[] = [
  { field: "positions", label: "Positions", path: ["positions"], hint: "Title strings, in file order." },
  { field: "locations", label: "Locations", path: ["locations"], hint: "Named places, used when scope is listed." },
]

const FILTER_LIST_ROWS: readonly ListRow<FilterListName>[] = [
  {
    field: "excludeLocations",
    label: "Exclude locations",
    path: ["exclude_locations"],
    hint: "Hire-from countries to drop; empty drops none.",
  },
  {
    field: "excludeCompanies",
    label: "Exclude companies",
    path: ["exclude_companies"],
    hint: "Dropped at search and gate, slug-compared.",
  },
  {
    field: "directRegions",
    label: "Direct regions",
    path: ["direct_regions"],
    hint: "Hire-from tokens that count as direct.",
  },
  {
    field: "marketCurrencies",
    label: "Market currencies",
    path: ["market_currencies"],
    hint: "Salary currencies the gate keeps.",
  },
]

type SearchFields = {
  readonly positions: TextareaInput
  readonly locations: TextareaInput
  readonly datePosted: SelectInput<Toggle>
  readonly locationScope: TextInput
} & Readonly<Record<`${ToggleGroupName}:${string}`, CheckboxInput>>

function SearchSection({ jobSearch, save }: { readonly jobSearch: JobSearch; readonly save: Save }) {
  const { submit, run } = useCardSave("job_search.yaml", save)
  // A hand-edited file can carry two windows; the select shows the first, and
  // the card stays clean until the user picks another.
  const loadedWindow = jobSearch.datePosted.find((row) => row.on)?.key ?? null
  const toggleFields: Record<`${ToggleGroupName}:${string}`, CheckboxInput> = {}
  for (const group of TOGGLE_GROUPS)
    for (const row of jobSearch[group.field])
      toggleFields[`${group.field}:${row.key}`] = new CheckboxInput({ label: humanize(row.key), defaultValue: row.on })
  const config: SearchFields = {
    ...toggleFields,
    ...listFields(SEARCH_LIST_ROWS, jobSearch),
    // date_posted carries exactly one window: two on means scout reads the
    // widest and the narrower one has no effect. A select can't hold two.
    datePosted: new SelectInput<Toggle>({
      label: "Date posted",
      items: jobSearch.datePosted,
      defaultValue: loadedWindow,
      getValue: (row) => row.key,
      getLabel: (row) => humanize(row.key),
      placeholder: "None",
      allowClear: true,
    }),
    locationScope: new TextInput({
      label: "Location scope",
      type: "text",
      defaultValue: jobSearch.locationScope,
      description: "worldwide, or listed to use the locations above.",
    }),
  }
  const { fields, values, onSubmit, reset } = useForm({
    fields: config,
    validate: (v) => ({
      positions: null,
      locations: null,
      datePosted: null,
      // Empty is a profile gap scout reports for itself; a typo is not, and
      // reaches scout as a scope that matches neither branch.
      locationScope: SCOPES.includes(v.locationScope) ? null : "Use worldwide or listed, or leave it empty.",
    }),
  })

  const toEdits = (v: FormOutputs<SearchFields>): readonly Edit[] => [
    ...TOGGLE_GROUPS.flatMap<Edit>((group) =>
      jobSearch[group.field].flatMap<Edit>((row) => {
        const on = v[`${group.field}:${row.key}`] ?? row.on
        return on === row.on ? [] : [{ op: "set", path: [group.key, row.key], value: on }]
      })
    ),
    ...(v.datePosted === loadedWindow ? [] : jobSearch.datePosted).flatMap<Edit>((row) => {
      const on = row.key === v.datePosted
      return on === row.on ? [] : [{ op: "set", path: ["date_posted", row.key], value: on }]
    }),
    ...SEARCH_LIST_ROWS.flatMap<Edit>((row) => {
      const next = fromLines(v[row.field])
      return sameList(next, jobSearch[row.field]) ? [] : [{ op: "set", path: row.path, value: [...next] }]
    }),
    ...changed(["location_scope"], v.locationScope, jobSearch.locationScope),
  ]
  const handleSave = onSubmit((v) => run(toEdits(v)))

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSave()
      }}
    >
      <FieldGroup>
        {TOGGLE_GROUPS.map((group) => (
          <FieldSet key={group.field}>
            <FieldLegend variant="label">{group.label}</FieldLegend>
            {jobSearch[group.field].map((row) => (
              <RowInput key={row.key} config={fields[`${group.field}:${row.key}`]} disabled={submit.isLoading} />
            ))}
          </FieldSet>
        ))}
        <FormInput config={fields.datePosted} disabled={submit.isLoading} />
        <FormInput config={fields.positions} disabled={submit.isLoading} />
        <FormInput config={fields.locations} disabled={submit.isLoading} />
        <FormInput config={fields.locationScope} className="max-w-sm" disabled={submit.isLoading} />
      </FieldGroup>
      <SaveButton submit={submit} dirty={toEdits(values).length > 0} onReset={reset} />
    </form>
  )
}

function FiltersSection({ jobSearch, save }: { readonly jobSearch: JobSearch; readonly save: Save }) {
  const { submit, run } = useCardSave("job_search.yaml", save)
  const config = {
    ...listFields(FILTER_LIST_ROWS, jobSearch),
    pruneScoreMax: new TextInput({
      label: "Prune score max",
      type: "number",
      defaultValue: String(jobSearch.pruneScoreMax),
      description: "The job-prune threshold; scout itself ignores it.",
      input: { inputMode: "numeric" },
    }),
  }
  const { fields, values, onSubmit, reset } = useForm({
    fields: config,
    validate: (v) => ({
      excludeLocations: null,
      excludeCompanies: null,
      directRegions: null,
      marketCurrencies: null,
      pruneScoreMax:
        v.pruneScoreMax.trim() !== "" && Number.isFinite(Number(v.pruneScoreMax)) ? null : "Enter a number.",
    }),
  })

  const toEdits = (v: FormOutputs<typeof config>): readonly Edit[] => {
    const prune = Number(v.pruneScoreMax)
    return [
      ...FILTER_LIST_ROWS.flatMap<Edit>((row) => {
        const next = fromLines(v[row.field])
        return sameList(next, jobSearch[row.field]) ? [] : [{ op: "set", path: row.path, value: [...next] }]
      }),
      // prune_score_max is a number in the file; a string here would retype the key.
      ...(prune === jobSearch.pruneScoreMax ? [] : [{ op: "set" as const, path: ["prune_score_max"], value: prune }]),
    ]
  }
  const handleSave = onSubmit((v) => run(toEdits(v)))

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSave()
      }}
    >
      <FieldGroup>
        {FILTER_LIST_ROWS.map((row) => (
          <FormInput key={row.field} config={fields[row.field]} disabled={submit.isLoading} />
        ))}
        <FormInput config={fields.pruneScoreMax} className="max-w-sm" disabled={submit.isLoading} />
      </FieldGroup>
      <SaveButton submit={submit} dirty={toEdits(values).length > 0} onReset={reset} />
    </form>
  )
}

type PackFields = Readonly<Record<`enabled:${string}`, CheckboxInput>> &
  Readonly<Record<`formulations:${string}`, TextareaInput>>

function PacksSection({ packs, save }: { readonly packs: readonly SearchPack[]; readonly save: Save }) {
  const { submit, run } = useCardSave("search_packs.yaml", save)
  // PackFields is Readonly, so the record is built as a mutable local first and
  // assigned once every row has contributed its two fields.
  const draft: Record<`enabled:${string}`, CheckboxInput> & Record<`formulations:${string}`, TextareaInput> = {}
  for (const pack of packs) {
    draft[`enabled:${pack.id}`] = new CheckboxInput({ label: "Enabled", defaultValue: pack.enabled })
    draft[`formulations:${pack.id}`] = listInput(
      "Formulations",
      `${pack.surface}. [role] expands from positions.`,
      pack.formulations
    )
  }
  const config: PackFields = draft
  const { fields, values, onSubmit, reset } = useForm({ fields: config })

  // `pack.index` is the row's position in the file, not its position on screen:
  // id-less rows are dropped from this list but still occupy a slot in the YAML.
  const toEdits = (v: FormOutputs<PackFields>): readonly Edit[] =>
    packs.flatMap<Edit>((pack) => {
      const enabled = v[`enabled:${pack.id}`] ?? pack.enabled
      const formulations = fromLines(v[`formulations:${pack.id}`] ?? toLines(pack.formulations))
      return [
        ...(enabled === pack.enabled ?
          []
        : [{ op: "set" as const, path: ["packs", pack.index, "enabled"], value: enabled }]),
        ...(sameList(formulations, pack.formulations) ?
          []
        : [{ op: "set" as const, path: ["packs", pack.index, "formulations"], value: [...formulations] }]),
      ]
    })
  const handleSave = onSubmit((v) => run(toEdits(v)))

  return (
    <form
      noValidate
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void handleSave()
      }}
    >
      <FieldGroup>
        {packs.map((pack) => (
          <FieldSet key={pack.id}>
            <FieldLegend variant="label" className="font-mono">
              {pack.id}
            </FieldLegend>
            <RowInput config={fields[`enabled:${pack.id}`]} disabled={submit.isLoading} />
            <RowInput config={fields[`formulations:${pack.id}`]} disabled={submit.isLoading} />
          </FieldSet>
        ))}
      </FieldGroup>
      <SaveButton submit={submit} dirty={toEdits(values).length > 0} onReset={reset} />
    </form>
  )
}

// Theme lives here rather than in the account menu: the console keeps every
// per-user preference on one surface, and a segmented control shows which of
// the three is active where a submenu could not.
function Appearance() {
  const { theme, setTheme } = useTheme()

  return (
    <Block label="Appearance">
      {/* divide-x, not a border per button: the console's segments share one
          hairline between them. */}
      <div className="inline-flex divide-x divide-divider self-start overflow-hidden border border-divider">
        {THEMES.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value as Theme)}
            data-active={theme === value}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
              "bg-muted/40 text-ink-soft hover:bg-inset",
              "data-active:bg-accent-blue-soft data-active:text-accent-blue-strong"
            )}
          >
            <HugeiconsIcon icon={Icon} className="size-3.5" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </Block>
  )
}

// The console's Profile page, part for part: an editable name/email form, a
// copyable monospace identifier, then the theme switch. The profile folder is
// our "User ID" — the one identifier that names this install.
function ProfileSection({
  label,
  basics,
  save,
}: {
  readonly label: string
  readonly basics: Basics
  readonly save: Save
}) {
  const [copied, setCopied] = useState(false)

  // StrictMode double-invokes effects, so the reset has to be cancellable —
  // same contract as ui/copy.tsx.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <>
      <BasicsForm rows={PROFILE_ROWS} basics={basics} save={save} />

      <Block label="Profile folder">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(label).then(
              () => setCopied(true),
              () => toast.error("Could not copy to the clipboard")
            )
          }}
          className="inline-flex cursor-pointer items-center gap-1 border-b border-dotted border-current font-mono text-xs text-ink-muted transition-colors hover:text-ink-strong"
        >
          {label}
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} className="size-3 opacity-60" aria-hidden="true" />
        </button>
      </Block>

      <Appearance />
    </>
  )
}

// A section's draft is seeded from props once, at mount. Keying it on its
// file's read stamp remounts exactly the section whose file the save rewrote,
// so it re-seeds from the reloaded profile.
function SettingsPanel({
  panel,
  profile,
  save,
}: {
  /** The AI panel renders outside ProfileGate, in the dialog, so it never reaches this switch. */
  readonly panel: Exclude<PanelId, "ai">
  readonly profile: Profile
  readonly save: Save
}) {
  const stampOf = (file: string): number => profile.stamps[file] ?? 0
  const basics = stampOf("basics.yaml")
  const search = stampOf("job_search.yaml")

  // max-w-xl space-y-8: the console's measured body stack — 576px wide, 32px
  // between blocks, no card anywhere on the surface.
  return (
    <div className="max-w-xl space-y-8">
      {(() => {
        switch (panel) {
          case "profile":
            return <ProfileSection key={basics} label={profile.label} basics={profile.basics} save={save} />
          case "basics":
            return <BasicsSection key={basics} basics={profile.basics} save={save} />
          case "profiles":
            return <SocialsSection key={stampOf("profiles.yaml")} socials={profile.socials} save={save} />
          case "languages":
            return <LanguagesSection key={stampOf("languages.yaml")} languages={profile.languages} save={save} />
          case "search":
            return <SearchSection key={search} jobSearch={profile.jobSearch} save={save} />
          case "filters":
            return <FiltersSection key={search} jobSearch={profile.jobSearch} save={save} />
          case "packs":
            return <PacksSection key={stampOf("search_packs.yaml")} packs={profile.packs} save={save} />
          default:
            return assertNever(panel)
        }
      })()}
    </div>
  )
}
