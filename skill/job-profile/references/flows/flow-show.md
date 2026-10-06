# Show

Read-only: `show`, `gaps`, and `cv` (display). Writes are `flow-mutate.md`.
Load `./references/schemas/schema-profile-card.md` now for card field sources (cache absent, hybrid,
or any `### Profile card` print).
Load `./references/contracts/contract-geography.md` for residence derivation and
hiring-location interpretation.

Packs **list** only (list my boards / packs): print `### Packs` and stop — no write.

## Read set (profile data under Profile root; contract under the loaded skill root)

| Path                                                    | Supplies                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data/basics.yaml`                                      | residence country, citizenships, permits                                                                                                                                                                     |
| `data/job_search.yaml`                                  | work_model, job_types, date_posted, positions, location (`search_in`, `exclude_hire_from`), market_currencies, exclude_companies, salary_range_usd, notice_period, open_to_relocation, `employment_routes.*` |
| `./references/contracts/contract-geography.md`          | shared residence and hiring-geography rules                                                                                                                                                                  |
| `data/answers.yaml`                                     | `qa[]`, `pending[]`                                                                                                                                                                                          |
| `data/skills.yaml`, `experiences.yml`, `languages.yaml` | card                                                                                                                                                                                                         |
| `data/profile_card.yaml`                                | card, when present — else derive in memory                                                                                                                                                                   |
| `data/search_packs.yaml`                                | deck: pack ids, `entry`, `enabled`, route requirement, route, tokens — one pack is one surface                                                                                                               |
| `data/cvs.yaml`                                         | CV: `adapt_per_vacancy` (absent → true) and `base`                                                                                                                                                           |

Glob `data/*.{yaml,yml}`. A missing optional file is a blank field, never a stop.
An unreadable file → stop and name it.
Run `./scripts/geography.py` from the loaded job-profile skill root with
`{"country": "<country string>", "places": []}`, using the empty string
when `data/basics.yaml` has no country, and follow the shared contract. Pass
the returned country and regions as
`constraints.residence`; do not show country codes. Missing or unresolved
residence stays unknown, and a missing country is a Gap; direct the operator
to `/job-profile continue fill basics.country`.
This flow remains read-only. If deprecated region configuration is present,
report that `/job-profile` must run the confirmed migration in `flow-mutate.md`;
do not enter the mutation flow here.

## Blocks

Print `### Profile card`, then `### Constraints` — this Blocks law is the
owner; job-scout preflight derives its card and constraints from it:

- Profile card: primary role · top skills · industries · languages
- Constraints: citizenships · residence country · work model · job types ·
  positions · search scope (`location.search_in`) · date_posted ·
  `location.exclude_hire_from` · market_currencies · exclude_companies ·
  salary_range_usd · accepted employment routes · relocation · derived
  `residence.regions`

Keep the Profile card's four fields above. In the readable Constraints block,
show the residence country and derived regions as `residence.country` and
`residence.regions`, and print the following lines once, filling them from the
loaded profile and geography helper. Hiring arrangements come only from
existing `employment_routes.*: Yes` facts; do not create another list of
accepted hiring routes.

```text
Citizenship: {confirmed citizenships, or —}
Work authorization: {citizenships + permits, or —}; elsewhere visa and sponsorship required
Work location: {residence country, or —}
Work model: {enabled work model flags}
Search scope: {location.search_in}
Hiring arrangements: {employment_routes facts with Yes}
Target roles: {positions open to candidates working from <country>, including
concise applicable regional labels such as LATAM and worldwide listings that
include <country>}
```

Keep the full canonical names in `residence.regions`; use concise labels only in
the target-role sentence.

This is the shared display contract job-scout uses.

`### Packs` third when `data/search_packs.yaml` is readable: `id · entry host ·
enabled|disabled · route=json|board|DOM|missing|invalid|disabled · location=surface|keep-only|invalid · tokens`.
`location=keep-only` when the pack declares `location: keep-only`; key absent → `location=surface`; any other present value → `location=invalid`, naming the pack.
A complete JSON route has `kind: json`, a `url` containing `{formulation}` and
`{page}`, and non-empty `pages`, `items`, and `posting_url` dot paths.
A complete board route has `kind: board`, `ats` in the `job-store/references/schemas/schema-dossier.md` "ATS family" vocabulary, a `url` containing `{slug}`, and non-empty `items`, `posting_url`, and `title` dot paths (no board-count; slugs are discovered at search).
Route status, first match: complete JSON route → `route=json`; complete board route → `route=board`; any other present
route → `route=invalid`; `route_required: true` and enabled → `route=missing`;
`route_required: true` and disabled → `route=disabled`; else `route=DOM`.
The same line must name the affected pack.
Route status belongs in `### Packs`, not the Gaps allowlist.

Absent → one line saying job-scout will STOP until this file exists (emit via
`/job-profile` or add packs via `/job-profile`).

`### Answers` fifth when `data/answers.yaml` `qa[]` or `pending[]` is non-empty or any `scout/applications/*/plan.json` has `needs_you[]`: one line per row, `{question} · {scope or global} · {unanswered for a pending[] row, else confirmed_at}`; answers are not printed. Then `{n} unanswered` = the union of distinct normalized `pending[]` `question`s, and distinct `needs_you[].what` (normalized as `job-apply/references/contracts/contract-screening.md` rule 3) across those plans for which no `qa[]` row has a non-empty `answer`, an equal normalized `question`, and either no `scope` or an `ats` scope equal to that plan's `ats`. A `company` or `country` scope never reduces the count: this flow reads no dossier, so the count is an upper bound.

`### CV` fourth when `data/cvs.yaml` is readable: `base`, plus `missing` when it
does not resolve under `cv/`, and `no latex` when its `.tex` sibling is absent.
Also print `adapt_per_vacancy: true|false` (absent → true).
Empty `base` → one line saying job-apply will attach `cv/en-us-resume.pdf`.
A base pointing at nothing prints here, not as a Gap.

Unknown value = `—`. Cache present → its non-empty fields win except
`primary_role`, always re-derived from current `job_search.yaml`.

Say which: `card: profile_card.yaml`, `card: derived`, or `card: hybrid`
(cache present but at least one always-derived field came from facts).

## Gaps

Print **only** these — this skill's own Gaps allowlist:

- `basics.country` when empty or unresolved
- `basics.citizenships` when empty
- `salary_expectations.salary_range_usd`
- `availability.notice_period`
- `employment_routes.employer_of_record`
- `job_search` `positions` when empty
- `job_search` `location.search_in` when empty

Never Gaps: `availability.open_to_relocation`,
`direct_contractor`, `local_employment`, empty `projects.yml` / `languages.yaml` /
experience `url.*`, `basics.permits`, CV.
Nothing outstanding → `Gaps: none`.
