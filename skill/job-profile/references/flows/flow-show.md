# Show

Read-only: `show`, `gaps`, and `cv` (display). Writes are `flow-mutate.md`.
Load `./references/schemas/schema-profile-card.md` now for card field sources (cache absent, hybrid,
or any `### Profile card` print).

Packs **list** only (list my boards / packs): print `### Packs` and stop — no write.

## Read set (all under Profile root)

| Path                                                    | Supplies                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/job_search.yaml`                                  | work_model, job_types, date_posted, positions, locations, location_scope, direct_regions, market_currencies, exclude_locations, exclude_companies |
| `data/candidate.yaml`                                   | salary_range_usd, notice_period, `legal_authorization.*`, `employment_routes.*`, `work_preferences_from_resume.*`, `screening_defaults.qa[]`      |
| `data/skills.yaml`, `experiences.yml`, `languages.yaml` | card                                                                                                                                              |
| `data/profile_card.yaml`                                | card, when present — else derive in memory                                                                                                        |
| `data/search_packs.yaml`                                | deck: pack ids, `entry`, `enabled`, route requirement, route, tokens — one pack is one surface                                                    |
| `data/cvs.yaml`                                         | CV: `adapt_per_vacancy` (absent → true) and `base`                                                                                                |

Glob `data/*.{yaml,yml}`. A missing optional file is a blank field, never a stop.
An unreadable file → stop and name it.

## Blocks

Print `### Profile card`, then `### Constraints` — this Blocks law is the
owner; job-scout preflight derives its card and constraints from it:

- Profile card: primary role · top skills · industries · languages
- Constraints: work model · job types · positions · locations ·
  date_posted · location_scope · direct_regions · market_currencies · exclude_locations · exclude_companies · salary_range_usd ·
  work auth · employment_routes · relocation

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

`### Answers` fifth when `data/candidate.yaml` `screening_defaults.qa[]` is non-empty or any `scout/applications/*/plan.json` has `needs_you[]`: one line per `qa[]` row, `{question} · {scope or global} · {unanswered when the answer is empty, else confirmed_at or unconfirmed}`; answers are not printed. Then `{n} unanswered` = the union of distinct normalized `question`s of `qa[]` rows with an empty `answer`, and distinct `needs_you[].what` (normalized as `job-apply/references/contracts/contract-screening.md` rule 3) across those plans for which no `qa[]` row has a non-empty `answer`, an equal normalized `question`, and either no `scope` or an `ats` scope equal to that plan's `ats`. A `company` or `country` scope never reduces the count: this flow reads no dossier, so the count is an upper bound.

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

- `salary_expectations.salary_range_usd`
- `availability.notice_period`
- `legal_authorization.*` when empty
- `employment_routes.employer_of_record`
- `job_search` `positions` when empty
- `job_search` `location_scope` when empty; `locations` when `location_scope` is
  `listed` and the list is empty

Never Gaps: remote / in-person prefs (`in_person_work*`),
`direct_contractor`, `local_employment`, empty `projects.yml` / `languages.yaml` /
experience `url.*`, `job_search.locations` except the `listed`+empty pair above, CV.
Nothing outstanding → `Gaps: none`.
