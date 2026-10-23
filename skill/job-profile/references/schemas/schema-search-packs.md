# `search_packs.yaml`

This is the single validation contract for the search deck and its optional
company-discovery extension. `flow-mutate.md` and `/job-company-scout` load
this schema before writing. Preserve unrelated keys and comments when editing.

## Root and packs

The root is a mapping with required `packs` (a list) and optional `discovery`
(a mapping). Pack `id` values are unique strings. A pack has:

| Key              | Shape and meaning                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | Required, non-empty string, unique in `packs`.                                                                                       |
| `surface`        | Required non-empty string. Known labels are `linkedin-jobs`, `open-web`, `social`, and `careers`; other operator labels are allowed. |
| `entry`          | Required absolute `http(s)` URL, except on a pack with `route.kind: companies`, where it is absent.                                  |
| `enabled`        | Optional boolean; absent means `true`.                                                                                               |
| `formulations`   | Optional non-empty list of strings.                                                                                                  |
| `route_required` | Optional boolean.                                                                                                                    |
| `location`       | Optional, exactly `keep-only`.                                                                                                       |
| `route`          | Optional mapping defined below.                                                                                                      |
| `boards`         | Optional list of employer boards, defined below. Only a board route consumes this list.                                              |

Unknown keys are retained by edits; they do not make a pack valid for a route
unless this schema defines them. An enabled pack with `route_required: true`
needs a complete supported route. A disabled pack may omit a route. Any
present but incomplete route is invalid, even if the pack is disabled.

### Routes

`route` is one of these mappings:

| `kind`      | Required fields                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `json`      | `url` contains `{formulation}` and `{page}`; non-empty `pages`, `items`, and `posting_url` strings.                                                                                                                                                                                               |
| `board`     | `ats` is an ATS family supported by `job-store/references/schemas/schema-dossier.md`; `url` contains `{slug}`; non-empty `items`, `posting_url`, and `title` strings. `location`, `date`, and `listed` paths and `slug_lists` are optional.                                                       |
| `careers`   | The pack has `surface: careers`, `location: keep-only`, and its required `entry` is an official company careers URL. Optional `company_id` and `company` identify an operator-authored route. A discovery-created route must have both fields and `managed_by: job-company-scout`.                |
| `companies` | The pack has `location: keep-only`. `csv` is an absolute local path to a company CSV with `row_id`, `region`, `tier`, `company_name`, `ats`, and `ats_tenant` columns (the market-research enriched list); non-empty `regions` list of `UK`, `US`, `EU`; non-empty `tiers` list of `A`, `B`, `C`. |

A `surface: careers` pack without `location: keep-only` fails validation.
Existing careers packs without a route remain DOM searches. A careers route's
`entry` is a careers page, not an individual posting. `company_id`, `company`,
and `managed_by` are pack-level fields, not fields inside `route`.
For discovery-owned packs, `company_id` refers to `discovery.companies` and
`company` is its verified display name.

### `boards[]`

Each optional row has required non-empty `company_id`, `name`, and absolute
`http(s)` `url`; optional `enabled` is boolean and defaults to `true`; optional
`managed_by` is the literal `job-company-scout`. Discovery-owned `company_id`
values refer to `discovery.companies`. User-authored rows omit `managed_by`
and may use a verified company hostname without a discovery record.
Rows are employer board roots for this ATS instance, never job-posting URLs.
Deduplicate by ATS instance and lowercased extracted tenant, not by company
name or literal URL spelling.

Company identity and ATS tenant are separate facts. Verify the ATS instance
from the official careers link, then derive the tenant slug from the board-root
URL. Reject an individual posting URL as a board. A Greenhouse, Ashby, or US
Lever tenant can be represented under its matching board route; EU Lever and
custom or unsupported boards use a `careers` pack.

## `discovery`

`discovery` is optional so existing profile decks remain valid. If present, it
has optional `markets`, `observations`, and `companies` mappings.

### Markets and sources

Each `markets.<market-id>` mapping has required boolean `enabled`, non-empty
`scope`, and a `sources` mapping. Each source has an absolute `http(s)` `url`
and `strategy`, either `news` or `portfolio`. Source names are stable identifiers.
The template configures `uk`, `us`, and `eu` markets in `job-profile/templates/data/search_packs.yaml`.

### Source observations

`observations` is keyed by canonical source URL. Canonicalization lowercases
the host, removes a default port and fragment, and preserves the path and
query; an empty path becomes `/`. Each value has:

| Key                        | Shape and update rule                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `first_seen_at`            | ISO-8601 timestamp; set once when the source is first observed.                                                        |
| `last_checked_at`          | ISO-8601 timestamp of the latest attempt, including a failed read.                                                     |
| `last_successful_check_at` | ISO-8601 timestamp of the latest complete successful inspection, or null until one succeeds; retain it after failures. |
| `seen_urls`                | List of normalized source-item URLs discovered in a successful inspection.                                             |
| `pending_urls`             | List of discovered item URLs not yet successfully inspected. Remove an item only after successful inspection.          |

On read or parse failure, preserve prior evidence, `seen_urls`, pending work,
and `last_successful_check_at`; record the failed attempt in
`last_checked_at`. Do not treat an inaccessible item as inspected.

### Companies

`companies` is keyed by verified official website host, lowercased with a
leading `www.` removed. The host must come from an official company site, not
from an investor, accelerator, or ATS tenant. Each company value has:

| Key                        | Shape                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | Verified current company name.                                                                                                                                        |
| `website`                  | Absolute official `http(s)` website URL as published; its host, lowercased with a leading `www.` removed, equals the key.                                             |
| `aliases`                  | List of verified former names or official hostnames for rebrands.                                                                                                     |
| `first_seen_at`            | ISO-8601 timestamp; immutable after creation.                                                                                                                         |
| `last_checked_at`          | ISO-8601 timestamp of the latest company check.                                                                                                                       |
| `last_successful_check_at` | ISO-8601 timestamp of the latest successful company inspection, or null until one succeeds; preserve on failure.                                                      |
| `relevance`                | Mapping with `status` (`pending`, `qualified`, or `rejected`), `reason`, and `evidence_urls` (list of URLs).                                                          |
| `markets`                  | Mapping from market id to `{status, reason, evidence_urls}`. Status is `pending`, `qualified`, or `rejected`.                                                         |
| `careers`                  | Mapping with `status` (`unknown`, `not_found`, or `found`). A `found` record also has its official careers `url`; `unknown` means inspection failed or is incomplete. |
| `evidence`                 | List of evidence records, defined below.                                                                                                                              |

Before creating a company, check existing keys and verified hostname aliases.
Never merge on a name match alone. An officially verified hostname change
rekeys the same record, retaining the former hostname as an alias, earliest
first-seen timestamps, evidence, and market memberships. Update discovery-owned
company references without changing their enabled states; preserve
operator-authored references and report any that need the operator's attention.
Conflicting identity evidence stays pending rather than merging records.

Each evidence record has `source_url`, ISO-8601 `first_seen_at`, `event_type`,
and `event_date`. `event_type` is a string or null. `event_date` is a string or
null and preserves the precision and form shown by the source (for example,
`2025`, `2025-04`, or `2025-04-18`); never invent a day or month. Keep the
evidence URL that supports each relevance or market decision in that
decision's `evidence_urls`.

`pending` means evidence is incomplete, `qualified` means the stated rule is
supported by evidence, and `rejected` means evidence confirms it does not
qualify. Market qualification follows the configured scope and
`job-company-scout/references/flows/flow-discover.md` evidence rules.
A company can be relevant to the profile while its market status
remains pending or rejected, and vice versa.

Job Scout consumes packs only. Discovery research never authorizes a job
candidate or substitutes for evidence from an individual posting.
