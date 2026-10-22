# Job scout — search

One pack at a time; never two on the same host.

A pack without `formulations` runs `["[role]"]`. Interpolate `[role]` from
positions (file order), `[industry]` from the card. Drop an empty leftover
token. Build every formulation × position before opening a surface.

Constraints `date_posted` is one window (`24_hours`, `week`, `month`; a legacy
bool map reads as its one true key; `all_time`, empty, `false`, or a map with no
true key → no bound). Every date control and date keep below reads it.

`worldwide` → each formulation once, location unfiltered: location control unset. A `search_in` list → cycle its entries. A pack with `location: keep-only` runs under a `search_in` list as under `worldwide`: each formulation once, location control unset, `search_in` applied at keep and gate only. Never infer keep-only from the surface; only the pack declares it. Any other present `location` value records `defect: query_not_submitted` and scans nothing, as an incomplete route does.

When a pack has `route`, consume it before any DOM search, except a
`kind: board` pack first runs `site:{entry host} {formulation}` on a
search engine for slug discovery, then GETs the route. That harvest
is not a second surface and not a DOM fallback: `entry` already
declared the host. A bot-wall, captcha, throttle, or empty interrupt on that
harvest records `defect: surface_interrupted` for the harvest and
still collects stored slugs (2) and list slugs (3); it does not stop the pack or mark route
GETs unsubmitted. A `kind: json` pack runs once
per expanded formulation; a `kind: board` pack runs once per board
slug. Location remains a keep filter instead of repeating the same
routed URL for every `search_in` entry.

- `kind: json` and `kind: board` are supported. A `kind: json` route opens `entry` to establish its browser origin,
  substitute the percent-encoded formulation and 1-based page into `url`, then
  GET that URL from page context.
- Resolve `items` and `pages` as dot paths in each JSON response. Resolve
  `posting_url` inside every item, normalize it, and retain the expanded
  formulation as `matched_query`. Populate standard candidate fields exposed by
  the item; absent fields remain `—` for posting-page extraction.
- Start at page 1 and stop at the configured total or when a page adds no new
  posting URL.
- A successful GET of the exact substituted URL is submission proof. An enabled
  `route_required: true` pack without a complete supported route, or any present
  incomplete route, records `defect: query_not_submitted` and scans nothing.
  HTTP failure, non-JSON output, or a missing configured response path records
  `defect: route_failed`. Never fall back to DOM after a configured or required
  route fails.
- `kind: board` needs `ats` (`job-store/references/schemas/schema-dossier.md`
  "ATS family" vocabulary), a `url` containing `{slug}`, and `items`,
  `posting_url`, `title` dot paths; `location`, `date`, and `listed` are
  optional dot paths; `slug_lists` is an optional list of http(s) URLs or
  paths relative to Profile root (passed to the collector as absolute paths).
  `items: $` names the response root. Collect slugs
  unique by lowercased slug: (1) each `site:` result URL this run;
  (2) every readable store dossier whose url host is this ATS family;
  (3) every row of each `slug_lists` entry. Run `./scripts/collect.py`
  (launcher per `job-match/references/flows/flow-match.md` **score**) once with
  `{"route", "slugs": <(1) and (2)>, "lists": <slug_lists>, "positions", "date_posted", "now"}`;
  it reads every list (a JSON array of strings is slugs; a CSV with a `url` column
  takes that URL's slug only when its host is this ATS family, else skips the
  row; a CSV with no `url` column uses its `slug` column) and GETs every slug.
  A list it reports `failed` is named under Gaps, never a route failure.
  A `collect_error`, exit 1, an unreadable script, or no Python 3 launcher →
  `defect: route_failed` for the pack, naming the error; no candidates.
  Slug = first path segment, except a Greenhouse embed URL
  (`/embed/…`, including `/embed/job_app` and `/embed/job_board`) whose slug is the `for` query value; no `for` →
  skip that URL. A `jobs.eu.lever.co` or `api.eu.lever.co` host is a
  separate Lever instance: skip it, do not GET `api.lever.co`.
  One GET per slug, `{slug}` percent-encoded; no slug is skipped or deferred
  to a later run. Empty (1)+(2)+(3) → `defect: no_boards`, scan
  nothing. `site:` cards on a `kind: board` pack are slug sources,
  not candidates; candidates come only from a successful route GET.
  Company = the `site:` card company, else the store company, else
  the collector's `company` (list row `name`, else the slug). Per candidate: `url` normalized;
  `matched_query` = the first `positions[]` entry the `title` contains as whole
  words, case-insensitive, punctuation ignored (the collector drops items with none,
  items whose `listed` resolves to `false`, and dated items outside `date_posted`);
  `channel` = `ats`. A slug the collector reports `failed` is a zero-keep run;
  every slug failing → `defect: route_failed`.

A pack without `route` runs the DOM flow. Open `entry`. ATS roots with no browsable
index (`job-boards.greenhouse.io`, `boards.greenhouse.io`, `jobs.lever.co`,
`jobs.ashbyhq.com`) use `site:{entry host} {formulation}` on a search engine
instead; an `entry` with a path opens directly. On a `site:` run the search
engine is the surface: set its date control to the `date_posted` window when it
has one, and expect stale rows regardless — the index is not the board, and
extract marks them `dead` (`./flow-extract.md`). There is no
board-registry file.

Surface filter controls matching Constraints `date_posted`, `work_model`,
`job_types`, and location (location omitted on a `location: keep-only` pack) — no others → set them before scanning. Paginate until
no next page or a page adds no new result URL. A zero-keep page is not a stop.

For DOM runs, proof is the surface echo matching the submitted string;
otherwise record `defect: query_not_submitted`. A DOM candidate's
`matched_query` is the expanded formulation whose echo proved the run,
verbatim. A card reached any other way — a category or index page, a board
listing, browsing on from `entry` — has no proven run and is not a candidate:
do not open it, do not emit it. The pack declares its surfaces; a run never
adds one. A source whose term search misses cards its category pages list is
a pack-routing change, not a sweep improvised in the run.

A surface or search engine that stops answering mid-matrix — a bot-wall,
captcha, throttle page, or an empty page for a query that kept cards earlier in
the same run — is an interrupt, never a zero and never `query_not_submitted`.
On the first such page, re-submit one formulation that kept cards earlier in
this run; a `site:` search-engine run may carry that query to one other engine
first, and a run that recovers on another engine counts as submitted. Still
empty → stop the pack there: every built run after the interrupted one
is unsubmitted, and the verdict is `defect: surface_interrupted`. A
`kind: board` harvest interrupt is the exception above: stored-slug
collection still runs. A query that
never kept cards in the run and is contradicted by no re-test stays a zero.

Load `job-profile/references/contracts/contract-geography.md` for geographic membership and explicit authorization requirements. Drop a card whose company slug (schema-dossier "Filename" rule) is in `exclude_companies`. Keep a card whose work_model intersects kit-true flags (unknown → keep; no kit-true flag → keep) and that matches Constraints `job_types` and `date_posted`. Location keep (first match): remote or hybrid-with-remote with printed permitted candidate locations incompatible with residence, or a known unmet explicit authorization requirement per the geography contract → drop; `worldwide` → keep; remote or hybrid-with-remote → keep; onsite or location-restricted → keep only if it matches a `search_in` entry (synonym OK); location unknown → keep (gate re-applies after extract). Unknown geographic membership or authorization stays unknown, never a country-based drop from employer location alone. Every kept candidate goes to extract; no pack has a candidate cap. Normalize URL per `job-store/references/schemas/schema-dossier.md`.

`channel` ∈ `direct_email` | `dm_request` | `founder` | `ats`. Unknown = `—`.

Every pack prints `### Candidates` then `### Defect log`:

`company | title | url | source | channel | author | contact | date | matched_query`

`source` is the pack `id` (an ad-hoc pack's id is its host), never the surface label or the posting host.

`pack | formulations_run | zero_result_runs | unsubmitted_runs | verdict`
`zero_result_runs` = runs that kept no card. `unsubmitted_runs` = built runs never submitted, counted after the interrupted run; `0` when none. An interrupted page is not a zero_result_run. A routed run is one expanded formulation, or one board slug on a `kind: board` pack, with location applied only as a keep filter. A DOM run is one expanded formulation, per entry under a `search_in` list, or once under `worldwide` or on a `location: keep-only` pack. Every run zero-keep → `defect: zero_results`. For DOM runs under a `search_in` list, every run for one entry zero-keep also → `defect: zero_results`; a `location: keep-only` pack has no per-location runs.
`verdict` ∈ `pass` | `auth_gate` | `defect: {name}`. No defect and no auth gate is `pass`. `unsubmitted_runs` above `0` is always `defect: surface_interrupted`; `query_not_submitted` names a pack fault (unknown `location` value, incomplete route, missing echo), never an interrupt.

## 2 Merge

One row per normalized URL. Prefer a named author. Channel sort: `direct_email` → `dm_request` → `founder` → `ats`.
