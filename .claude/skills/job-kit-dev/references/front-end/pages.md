# Pages

Every data-driven page follows one skeleton: a layout shell wraps a **`RemoteData`** cell that a **`Future.fork`**
fills inside `useEffect`; the render branches **exhaustively** (`instanceof … satisfies never`); a
**container/presentational split** keeps the page component thin; and the data comes from a **composed `Future` layer**
(`.map` to project a field, `Future.concurrently` for independent reads, `.chain` for a dependent step, and
`Future.mapConcurrently` to fan out over a collection). The same skeleton serves list pages, detail pages, dashboards —
any screen that fetches and renders.

Table a page renders: `./tables.md`. Write that mutates its data: `./forms.md`. Visual constraints: `./design-system.md`. Nearby pages: `packages/frontend/src/pages/resumes.tsx` (smallest), `packages/frontend/src/pages/dossiers.tsx` (full).

## Audit

- Find the layout shell (`AccessGate` in `packages/frontend/src/module/access/access-gate.tsx`, or the `StoreGate` / `ProfileGate`
  built on it) and the `RemoteData` / `Future` modules (`packages/lib/remote-data.ts`, `packages/lib/future.ts`).
- Read one nearby page before editing — match its state-cell shape, exhaustive match, and container/presentational
  split.

Report the audit briefly:

```md
Page Audit:

- Layout shell:
- RemoteData / Future modules:
- Read endpoints (api.*):
- Data-layer composition (map / concurrently / chain / mapConcurrently):
- Container/presentational boundary:
- Nearby pages referenced:
```

## Canonical references (by role)

- **`@lib/remote-data`** — `RemoteData`, `NotAsked` / `Loading` / `Failed` / `Ready`.
- **`@lib/future`** — `Future`, `Future.concurrently`, `Future.mapConcurrently`, `.chain`, `.map`, `.fork`.
- **`@api/endpoints` / `@api/request`** — typed `api.*` + `call`, `FetchError`, `fetchErrorToString` (transport
  error → string) (see `./forms.md`).
- **`@lib/json/schema`** — `s.Infer<typeof api.<name>.response>` derives a response type.
- **`@module/access/access-gate`** — `AccessGate` (shell: title + icon) plus `LoadingRows` (loading surface);
  **`@ui/alert`** — `Alert variant="destructive"` + `AlertDescription` (failure surface).
- **`@ui/datatable`** — `DataTable` (see `./tables.md`).

## Imports

    import { Megaphone01Icon } from "@hugeicons/core-free-icons";
    import * as s from "@lib/json/schema";
    import { type RemoteData, NotAsked, Loading, Failed, Ready } from "@lib/remote-data";
    import { Future } from "@lib/future";
    import { api } from "@api/endpoints";
    import { call, fetchErrorToString, type FetchError } from "@api/request";
    import { AccessGate, LoadingRows } from "@module/access/access-gate";
    import { Alert, AlertDescription } from "@ui/alert";
    import { DataTable, ColumnDef, type ColumnsConfig } from "@ui/datatable";

## 1. The page state cell (`RemoteData` + `Future.fork`)

Model the whole page as one `RemoteData<FetchError, T>` cell. Kick the read in `useEffect`: set `Loading()`,
then `.fork(onError → Failed, onSuccess → Ready)`. `fork` returns a cancel function — return it from the effect so an
in-flight read is cancelled on unmount or dependency change (`packages/frontend/src/app.tsx` does the same for `reloadSession`):

    const [state, setState] = useState<RemoteData<FetchError, CampaignDetails[]>>(NotAsked());
    useEffect(() => {
      setState(Loading());
      return fetchCampaigns(orgId).fork(e => setState(Failed(e)), v => setState(Ready(v)));
    }, [orgId]);

The seed follows the cell's success type. A **data cell** (`RemoteData<E, T>`, where `Ready` holds the content the
page renders — the shape above) always seeds `NotAsked()` and only sets `Loading()` inside the effect. A
**status-only cell** (`RemoteData<E, void>` — no content on `Ready`, e.g. a save in flight) also seeds `NotAsked()`;
`useCardSave` in `packages/frontend/src/module/profile/components/settings-surface.tsx` is the example.

## 2. Exhaustive rendering (`instanceof … satisfies never`)

Branch every `RemoteData` case with `instanceof`, ending in `(state satisfies never)` so adding a new variant becomes
a compile error. `Ready` → content; `Loading` / `Failed` / `NotAsked` → status surfaces:

    {state instanceof Ready ? <Content state={state.value} />
    : state instanceof Loading || state instanceof NotAsked ? <LoadingRows />
    : state instanceof Failed ? <Alert variant="destructive"><AlertDescription>{fetchErrorToString(state.error)}</AlertDescription></Alert>
    : (state satisfies never)}

## 3. Container / presentational split

The page component owns state and the exhaustive match — nothing else. A presentational `Content` receives the
resolved value and renders; the table is its own component. Keep each child small and prop-typed.

## 4. Composed `Future` data layer

Build the read as a composition, not nested forks:

- `.map` projects a field off a response (`listActivities → result.activities`).
- `Future.concurrently({ a, b })` runs independent reads together and joins them into one object.
- `.chain` sequences a dependent step (list → per-row detail).
- `Future.mapConcurrently(fn, list)` fans out over the list with bounded concurrency.

Only the page's `useEffect` forks; the layer stays lazy until then.

## Do / Do not

- Do: model the page as one `RemoteData` **data** cell (`RemoteData<E, T>`) seeded `NotAsked()`; set `Loading()`
  then `.fork` inside `useEffect`.
- Do: return `fork`'s cancel from the effect; key the effect on its inputs (`[orgId]`).
- Do: end the render match with `(state satisfies never)`.
- Do: compose the read (`concurrently` / `mapConcurrently` / `chain` / `map`) and fork once, at the page.
- Do: split the container (state) from the presentational (render) component.
- Do not: nest `.fork` calls or fire reads outside `useEffect`; do not drop the cancel return.
- Do not: render off a non-exhaustive match.

## Examples

The campaign / org / activity endpoints below are illustrative: `api` in `packages/frontend/src/api/endpoints.ts` holds only the
auth endpoints today. Swap in the real `api.*` entries and derive their types with `s.Infer`.

### The page component — `RemoteData` cell + exhaustive match

The page owns one `RemoteData` cell, fills it with `fetchCampaigns(...).fork` in `useEffect` (returning the cancel),
and renders an exhaustive `instanceof … satisfies never` match. `CampaignDetails` (defined here) is the resolved row
shape the rest of the example builds and consumes.

```tsx
export default CampaignsPage

type ListCampaignsResponse = s.Infer<typeof api.listCampaigns.response>
type GetOrgResponse = s.Infer<typeof api.getOrg.response>
type ListActivitiesResponse = s.Infer<typeof api.listActivities.response>

type CampaignDetails = {
  campaign: ListCampaignsResponse["campaigns"][number]
  // getOrg returns the org's fields at the top level, so the whole response IS the org.
  org: GetOrgResponse
  activities: ListActivitiesResponse["activities"][number][]
}

function CampaignsPage({ orgId }: { orgId: string }) {
  const [state, setState] = React.useState<RemoteData<FetchError, CampaignDetails[]>>(NotAsked())

  React.useEffect(() => {
    setState(Loading())
    return fetchCampaigns(orgId).fork(
      (e) => setState(Failed(e)),
      (v) => setState(Ready(v))
    )
  }, [orgId])

  return (
    <AccessGate title="Campaigns" Icon={Megaphone01Icon}>
      {() =>
        state instanceof Ready ? <Content state={state.value} />
        : state instanceof Loading || state instanceof NotAsked ? <LoadingRows />
        : state instanceof Failed ?
          <Alert variant="destructive">
            <AlertDescription>{fetchErrorToString(state.error)}</AlertDescription>
          </Alert>
        : (state satisfies never)
      }
    </AccessGate>
  )
}
```

### Container / presentational split

`Content` is presentational — it receives the already-resolved `CampaignDetails[]` and renders. Table row mapping: `./tables.md`.

```tsx
function Content({ state }: { state: CampaignDetails[] }) {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-semibold text-foreground">Campaigns</h3>
          <p className="text-sm text-muted-foreground">Overview of all campaigns.</p>
        </div>
      </div>
      <CampaignsTable data={state} />
    </div>
  )
}
```

### The composed `Future` data layer

Each read is a small `Future`; they compose without nested forks. `.map` projects a field, `Future.concurrently` runs
the two independent per-campaign reads together, `.chain` sequences the dependent step, and `Future.mapConcurrently`
fans out over the list. Nothing executes until the page's `useEffect` forks `fetchCampaigns`.

```tsx
function fetchActivitiesByCampaignId(
  campaignId: ListCampaignsResponse["campaigns"][number]["campaignId"]
): Future<FetchError, ListActivitiesResponse["activities"][number][]> {
  // listActivities takes a discriminated request; scope it to the campaign, then project the field.
  return call(api.listActivities, { scope: "Campaign", campaignId }).map((result) => result.activities)
}

function fetchOrgById(orgId: string): Future<FetchError, GetOrgResponse> {
  return call(api.getOrg, { orgId })
}

function fetchCampaignDetails(
  campaign: ListCampaignsResponse["campaigns"][number]
): Future<FetchError, CampaignDetails> {
  // Two independent reads, both derived from the campaign -> run concurrently.
  return Future.concurrently<
    FetchError,
    { org: GetOrgResponse; activities: ListActivitiesResponse["activities"][number][] }
  >({
    org: fetchOrgById(campaign.orgId),
    activities: fetchActivitiesByCampaignId(campaign.campaignId),
  }).map(({ org, activities }) => ({ campaign, org, activities }))
}

function fetchCampaigns(orgId: string): Future<FetchError, CampaignDetails[]> {
  // The list result feeds the per-row fan-out -> .chain, then mapConcurrently over the list.
  // statuses: [] = no status filter (list every campaign in the org).
  return call(api.listCampaigns, { orgId, statuses: [] }).chain((result) =>
    Future.mapConcurrently((campaign) => fetchCampaignDetails(campaign), result.campaigns)
  )
}
```
