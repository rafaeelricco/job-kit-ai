# Forms and API integration

Every frontend write follows one recipe: pick a typed `api.*` entry, fire it with **`call(endpoint,
body)`** (which returns a lazy **`Future`**), and handle the outcome with **`.fork(onError,
onSuccess)`** at the boundary. Build the inputs with **`useForm`** —
**config classes** for `fields`, a `validate` keyed to those fields, and `<FormInput>` to render
each one. Model submit state as a **`RemoteData`** cell.

Page that hosts a form: `./pages.md`. Collection a write mutates: `./tables.md`. HTTP helpers live in `packages/frontend/src/api/request.ts`; the `api` object in `packages/frontend/src/api/endpoints.ts`.

## Audit

- Inspect `packages/frontend/package.json` and the aliases in `packages/frontend/tsconfig.json` (`@api/*`, `@ui/*`, `@lib/*`, `@module/*`).
- Find `src/api/endpoints.ts` (the `api` object), `src/api/request.ts` (`call`, `fetchErrorToString`),
  and `src/components/ui/forms.tsx` (`useForm`/`FormInput`).
- Read one or two nearby write flows before editing — `src/pages/sign-in.tsx` for a server write,
  `src/module/profile/components/settings-surface.tsx` for a file write — and match their import surface and fork shape.

Report the audit briefly:

```md
Forms and API Integration Audit:

- Package surface:
- Endpoints module (api object):
- Request helper (call):
- Form abstraction (useForm/FormInput):
- Nearby write/read flows:
```

## Canonical references (by role)

- **`@api/endpoints`** — the `api` object; each entry is a server `endpoint` imported from its
  `@be/domain/<domain>/{command,query}/<name>.api` file.
- **`@api/request`** — `call(endpoint, body)` → `Future<FetchError, Res>`, and `fetchErrorToString`.
- **`@ui/forms`** — `useForm`, `FormInput`, the `FormOutputs` type, and config classes (`TextInput`,
  `TextareaInput`, `RichTextInput`, `DateInput`, `TimeInput`, `CheckboxInput`, `MoneyInput`,
  `ComboboxInput`, `SelectInput`, `TagsInput`).
- **`@lib/remote-data`** — `RemoteData`, `NotAsked`, `Loading`, `Failed`, `Ready`.
- **`@lib/future`** — `Future`, and the `Cancel` that `.fork` returns.

## Imports

    import { FormInput, TextInput, TextareaInput, useForm } from "@ui/forms"
    import { api } from "@api/endpoints"
    import { call, fetchErrorToString, type FetchError } from "@api/request"
    import { type Cancel } from "@lib/future"
    import { Failed, Loading, NotAsked, Ready, type RemoteData } from "@lib/remote-data"

## 1. Calling the backend

Use the typed `api.*` entries; never hand-roll `fetch` for a server command or query. `api` holds only
what the app calls today (e.g. `api.requestCode`, `api.whoAmI`); when `api.<name>` is absent, define the
endpoint server-first (`../back-end/index.md` → commands.md / queries.md), then import its `endpoint`
into `api`. `call` returns a lazy `Future` — nothing runs until `.fork`, which returns a cancel function:

    cancel.current = call(api.requestCode, { email }).fork(
      (err) => setSubmit(Failed(err)),
      () => onSent(email),
    )

- `.chain` sequences dependent writes; `Future.parallel` / `Future.concurrently` run independent
  ones. (`Future` vocabulary: the composed data layer in `./pages.md`.)
- Keep the `Cancel` in a ref and call it on unmount, so a late reply never lands on an unmounted form.

## 2. The form (`useForm`)

Define `fields` with **config classes** and a `validate` returning a per-field `string | null` map
**keyed exactly to `fields`** (`null` = no error). `useForm` returns `{ fields, values, onSubmit, reset }`:

    const { fields, onSubmit } = useForm({
      fields: {
        name: new TextInput({ label: "Name", type: "text", defaultValue: "", placeholder: "…" }),
        description: new TextareaInput({ label: "Description", defaultValue: "", rows: 3 }),
        company: new ComboboxInput<Company>({
          label: "Company", items: companies, defaultValue: null,
          getValue: (c) => c.slug, getLabel: (c) => c.name, allowClear: true,
        }),
        startDate: new DateInput({ label: "Start date", defaultValue: null }),
      },
      validate: (values) => ({
        name: values.name.trim() === "" ? "Name is required." : null,
        description: null,
        company: null,
        startDate: null,
      }),
    });

Render each field with `<FormInput config={fields.x} disabled={submit.isLoading} />`. Wrap the
handler with `onSubmit(cb)` — it validates first and only calls `cb(values)` when every error is
`null`. `onSubmit` returns an async listener; invoke it as `() => void handleCreate()`.

`useForm` also returns `values` (every field's current value, for a dirty check or live preview) and
`reset()` (back to each `defaultValue`, errors cleared). Omit `validate` when no field has a rule. Its
result must still name every fixed key; generated row keys (below) may be left out and count as `null`. `fields` is read once, at mount: a form whose defaults
come from loaded data remounts with a React `key` when that data reloads.

Rows read from data (one field per list entry) get generated keys such as `` `${row.id}:username` ``.
Type them with a template-literal record, e.g. ``Record<`enabled:${string}`, CheckboxInput>``, and
treat a lookup as possibly `undefined`.

## 3. Boundary conversions

Convert form strings and nullable selections at the submit boundary: `values.name.trim()`,
`DateOnly` → `POSIX` with `POSIX.fromLocalDateAndTime` from `@lib/time` (it returns a `Maybe<POSIX>`),
and treat empty select/combobox selections as `null`. Cross-field rules (e.g. end-after-start) live in
`validate`.
Keep stored timestamps as `POSIX` (and durations as `Duration`) through the app; convert to raw
ms only at platform/API edges — see `../time.md`.

## 4. Submit state (`RemoteData`)

Model the write like any async state: a `RemoteData<FetchError, never>` cell, `Loading()` before, `Failed` /
`Ready` inside `.fork`. The `submit.isLoading` flag (mirrored by the disabled submit button) guards
against double-submit:

    const [submit, setSubmit] = useState<RemoteData<FetchError, never>>(NotAsked())

    const handleSend = onSubmit((values) => {
      if (submit.isLoading) return
      setSubmit(Loading())
      cancel.current = requestCode(values.email.trim()).fork(
        (err) => setSubmit(Failed(err)),
        () => onSent(values.email.trim()),
      )
    })

Keep the error typed in the cell and convert it where it renders: an inline `<Alert variant="destructive">`
with `fetchErrorToString(submit.error)` (or `describeSaveError` for file writes). A form that unmounts on
success (a step change, a redirect, a keyed remount) never needs `Ready`.

## 5. File writes (profile YAML)

The settings surface writes the profile's YAML through File System Access, not the server, and follows
the same recipe. `save(file, edits)` from `useProfile` (`@module/profile/helpers/use-profile`) returns a
`Future<SaveError, void>`. Each card computes its `Edit[]` from `values` against the loaded profile, so a
save rewrites only the keys the user changed, and `edits.length > 0` is the card's dirty flag. A successful
save reloads the profile, and `SettingsPanel` keys each card on its file's read stamp, so the card remounts
with fresh defaults.

## Do / Do not

- Do: use `api.*` + `call`; handle the `Future` with `.fork` at the boundary and cancel it on unmount.
- Do: define `fields` with config classes; keep `validate` keyed to `fields` (`string | null`).
- Do: model submit state with `RemoteData`; set `Loading()` first; guard double-submit with the `submit.isLoading` flag and a disabled submit button.
- Do not: raw `fetch` a server command/query; add React Hook Form / Formik / Zod / a new request dep.
- Do not: use `validate` keys that don't match `fields`.
- Do not: re-seed a mounted form from new props; remount it with a `key`.

## Examples

`call` source: `packages/frontend/src/api/request.ts`. Registry source: `packages/frontend/src/api/endpoints.ts`.

Catalog entries are self-contained (`<form>` boilerplate repeated) so any one block stands alone.

### A worked write flow — sign-in email step

The real flow in `packages/frontend/src/pages/sign-in.tsx`: `useForm` + `validate` → `RemoteData` submit cell →
`Future` forked, its cancel kept for unmount → inline `Alert` on `Failed`.

```tsx
import { useEffect, useRef, useState } from "react"
import { type Cancel } from "@lib/future"
import { Failed, Loading, NotAsked, type RemoteData } from "@lib/remote-data"
import { fetchErrorToString, type FetchError } from "@api/request"
import { requestCode } from "@module/session/session"
import { Alert, AlertDescription } from "@ui/alert"
import { Button } from "@ui/button"
import { FormInput, TextInput, useForm } from "@ui/forms"

/** Asks for a sign-in code. The server answers alike for listed and unlisted addresses. */
function EmailForm({ defaultEmail, onSent }: { defaultEmail: string; onSent: (email: string) => void }) {
  const [submit, setSubmit] = useState<RemoteData<FetchError, never>>(NotAsked())
  const cancel = useRef<Cancel>(() => {})
  useEffect(() => () => cancel.current(), [])

  const { fields, onSubmit } = useForm({
    fields: {
      email: new TextInput({
        label: "Email",
        hideLabel: true,
        type: "email",
        defaultValue: defaultEmail,
        placeholder: "Email address",
        input: { autoComplete: "email" },
      }),
    },
    validate: (values) => ({
      email:
        values.email.trim() === "" ? "Enter your email address."
        : !values.email.includes("@") ? "Enter a valid email address."
        : null,
    }),
  })

  const sendCode = (email: string): void => {
    if (submit.isLoading) return
    setSubmit(Loading())
    cancel.current = requestCode(email).fork(
      (error) => setSubmit(Failed(error)),
      () => onSent(email)
    )
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => sendCode(values.email.trim()))()
      }}
      className="flex flex-col gap-4"
    >
      <FormInput config={fields.email} className="h-10" disabled={submit.isLoading} />
      {submit instanceof Failed ?
        <Alert variant="destructive">
          <AlertDescription>{fetchErrorToString(submit.error)}</AlertDescription>
        </Alert>
      : null}
      <Button type="submit" className="h-10 w-full px-6" disabled={submit.isLoading}>
        Send code
      </Button>
    </form>
  )
}
```

### Input catalog 1 — Text inputs (type matrix + icon + description)

The `type` prop drives the native input mode; `icon` and `description` are optional.

```tsx
import { Mail01Icon } from "@hugeicons/core-free-icons"

function TextField() {
  const { fields, onSubmit } = useForm({
    fields: {
      name: new TextInput({
        label: "Full name",
        type: "text",
        defaultValue: "",
        placeholder: "e.g. Dana Lopez",
        description: "Shown on the operator's profile.",
      }),
      email: new TextInput({
        label: "Email",
        type: "email",
        defaultValue: "",
        icon: Mail01Icon,
      }),
      password: new TextInput({
        label: "Password",
        type: "password",
        defaultValue: "",
      }),
      seats: new TextInput({
        label: "Seats",
        type: "number",
        defaultValue: "1",
      }),
      website: new TextInput({
        label: "Website",
        type: "url",
        defaultValue: "",
        placeholder: "https://…",
      }),
    },
    validate: (values) => ({
      name: values.name.trim() ? null : "Name is required.",
      email: values.email.includes("@") ? null : "Enter a valid email.",
      password: values.password.length >= 8 ? null : "At least 8 characters.",
      seats: Number(values.seats) > 0 ? null : "Must be at least 1.",
      website: null,
    }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => console.log(values))()
      }}
      className="max-w-md space-y-4"
    >
      <FormInput config={fields.name} />
      <FormInput config={fields.email} />
      <FormInput config={fields.password} />
      <FormInput config={fields.seats} />
      <FormInput config={fields.website} />
      <Button type="submit">Submit</Button>
    </form>
  )
}
```

### Input catalog 2 — Textarea

Multi-line free text; `rows` sets initial height.

```tsx
function TextareaField() {
  const { fields, onSubmit } = useForm({
    fields: {
      notes: new TextareaInput({
        label: "Notes",
        defaultValue: "",
        placeholder: "Anything the team should know…",
        rows: 4,
      }),
    },
    validate: () => ({ notes: null }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => console.log(values))()
      }}
      className="max-w-md space-y-4"
    >
      <FormInput config={fields.notes} />
      <Button type="submit">Submit</Button>
    </form>
  )
}
```

### Input catalog 3 — Rich text (html / plain)

`mode: "html"` stores markup; `mode: "text"` stores plain text. Value is a string.

```tsx
function RichTextField() {
  const { fields, onSubmit } = useForm({
    fields: {
      summary: new RichTextInput({
        label: "Summary",
        mode: "html",
        defaultValue: "",
      }),
    },
    validate: (values) => ({
      summary: values.summary.trim() ? null : "Summary is required.",
    }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => console.log(values))()
      }}
      className="max-w-md space-y-4"
    >
      <FormInput config={fields.summary} />
      <Button type="submit">Submit</Button>
    </form>
  )
}
```

### Input catalog 4 — Date + time with cross-field validation

Values are `DateOnly | null` and `TimeOfDay | null`. Cross-field rules live in `validate`, which receives every
field's value (here: end must be after start). `TimeOfDay` has no public comparator, so compare via the minutes helper.

```tsx
function DateAndTimeField() {
  const { fields, onSubmit } = useForm({
    fields: {
      date: new DateInput({ label: "Date", defaultValue: null }),
      startTime: new TimeInput({
        label: "Start time",
        defaultValue: null,
        step: 300,
      }),
      endTime: new TimeInput({
        label: "End time",
        defaultValue: null,
        step: 300,
      }),
    },
    validate: (values) => ({
      date: values.date ? null : "Date is required.",
      startTime: values.startTime ? null : "Start time is required.",
      endTime:
        values.endTime == null ? "End time is required."
        : values.startTime != null && timeOfDayToMinutes(values.endTime) <= timeOfDayToMinutes(values.startTime) ?
          "End must be after start."
        : null,
    }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => console.log(values))()
      }}
      className="max-w-md space-y-4"
    >
      <FormInput config={fields.date} />
      <FormInput config={fields.startTime} />
      <FormInput config={fields.endTime} />
      <Button type="submit">Submit</Button>
    </form>
  )
}

// TimeOfDay carries no public comparator; convert to minutes-since-midnight to order two values.
function timeOfDayToMinutes(t: TimeOfDay): number {
  const [hours = 0, minutes = 0] = t.pretty().slice(0, 5).split(":").map(Number)
  return hours * 60 + minutes
}
```

### Input catalog 5 — Select vs combobox vs tags

`SelectInput` → native dropdown (short fixed lists); `ComboboxInput` → searchable (long lists; adds
`emptyMessage`/`itemToString`); `TagsInput` → free-form `string[]`. Select/Combobox value is the `getValue()` string
(or null) — map back to the item at the boundary.

```tsx
type Region = { id: string; name: string }

const SAMPLE_REGIONS: Region[] = [
  { id: "r-1", name: "North" },
  { id: "r-2", name: "South" },
]

function ChoiceFields() {
  const { fields, onSubmit } = useForm({
    fields: {
      region: new SelectInput<Region>({
        label: "Region",
        items: SAMPLE_REGIONS,
        defaultValue: null,
        getValue: (r) => r.id,
        getLabel: (r) => r.name,
        placeholder: "None",
        allowClear: true,
      }),
      venue: new ComboboxInput<Region>({
        label: "Venue",
        items: SAMPLE_REGIONS,
        defaultValue: null,
        getValue: (r) => r.id,
        getKey: (r) => r.id,
        getLabel: (r) => r.name,
        itemToString: (r) => r.name,
        placeholder: "Search venues…",
        emptyMessage: "No venues found.",
        allowClear: true,
      }),
      tags: new TagsInput({
        label: "Tags",
        defaultValue: [],
        placeholder: "Add a tag and press Enter",
      }),
    },
    validate: (values) => ({
      region: values.region ? null : "Pick a region.",
      venue: null,
      tags: null,
    }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => console.log(values))()
      }}
      className="max-w-md space-y-4"
    >
      <FormInput config={fields.region} />
      <FormInput config={fields.venue} />
      <FormInput config={fields.tags} />
      <Button type="submit">Submit</Button>
    </form>
  )
}
```

### Input catalog 6 — Checkbox

Boolean value; combine several in `validate` for "at least one" rules.

```tsx
function CheckboxField() {
  const { fields, onSubmit } = useForm({
    fields: {
      operator: new CheckboxInput({ label: "Operator", defaultValue: true }),
      developer: new CheckboxInput({ label: "Developer", defaultValue: false }),
    },
    validate: (values) => {
      const none = !values.operator && !values.developer
      return {
        operator: none ? "Select at least one role." : null,
        developer: none ? "Select at least one role." : null,
      }
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => console.log(values))()
      }}
      className="max-w-md space-y-4"
    >
      <FormInput config={fields.operator} />
      <FormInput config={fields.developer} />
      <Button type="submit">Submit</Button>
    </form>
  )
}
```

### Input catalog 7 — Derived field (slug from name)

`derive` computes one field from the others on every change. Only `TextInput` fields are derivable; the user can still
edit a derived field and validation runs on the result.

```tsx
function DerivedField() {
  const { fields, onSubmit } = useForm({
    fields: {
      name: new TextInput({
        label: "Name",
        type: "text",
        defaultValue: "",
        placeholder: "Acme Beverages",
      }),
      slug: new TextInput({
        label: "Slug",
        type: "text",
        defaultValue: "",
        description: "Auto-filled from the name.",
      }),
    },
    derive: (values) => ({ slug: slugify(values.name) }),
    validate: (values) => ({
      name: values.name.trim() ? null : "Name is required.",
      slug: isValidSlug(values.slug.trim()) ? null : "Lowercase letters, numbers and dashes only.",
    }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void onSubmit((values) => console.log(values))()
      }}
      className="max-w-md space-y-4"
    >
      <FormInput config={fields.name} />
      <FormInput config={fields.slug} />
      <Button type="submit">Submit</Button>
    </form>
  )
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function isValidSlug(value: string): boolean {
  return value.length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}
```
