# Discover companies

This flow is entered only from an explicit `/job-company-scout` invocation or
a direct request to discover companies or boards. The request authorizes
market research and maintenance of discovery-owned
history and board inputs. It never authorizes a job search, applications,
messages, or scheduled work.

## Read-only profile context

Profile root comes from `job-profile-root`, loaded by `SKILL.md`. Use
`job-profile/references/flows/flow-show.md`'s read set and derivation rules for
the Profile card and Constraints; do not route through `job-profile/SKILL.md`.
Load
`job-profile/references/schemas/schema-search-packs.md` as the sole schema for
the deck and discovery extension. Do not enter the profile mutation flow.

## Preflight and run selection

1. Resolve `data/search_packs.yaml` against Profile root. Missing or malformed
   file: stop, name the path and parser error, and write nothing. Do not browse.
2. If `discovery` is absent, read only its block from
   `job-profile/templates/data/search_packs.yaml`. Use it in memory to list or
   validate markets; stage it only when a market run is selected. Never
   initialize it on `/job-scout` or `/job-profile`.
3. A request with no market arguments is list-only: print enabled market ids
   and their scopes from the deck (or the template block when absent), then wait.
   Do not browse or write.
4. `all` selects every enabled market. Otherwise select the named market ids,
   deduplicated and processed in file order. Reject `all` combined with ids,
   unknown ids, and disabled ids before browsing or staging a write.
5. For each selected market, inspect its configured news and portfolio sources
   and all available pagination with the web or browser tools. Process markets
   and sources serially in file order. Do not use LinkedIn session harvesting.
   For `strategy: news`, inspect article links and preserve their publication
   dates. For `strategy: portfolio`, inspect company links; observation dates
   are not founding dates. Retain unprocessed links when coverage is interrupted.

## Research and evidence

Use the Profile card and Constraints to judge relevance. Keep an auditable
record for each observed company, including evidence URLs, and preserve the
source's date precision. Keep event dates such as `2025`, `2025-04`, or
`2025-04-18` in the form reported; do not manufacture missing precision.

Company identity is its verified official website host, lowercased with
leading `www.` removed. Verify the company website from a reliable source, then
verify its name and any rebrand aliases against official company evidence.
Store `website` as published; never rewrite it to the key host.
Investor, accelerator, and ATS tenant hosts are not company identity. If the
official host or identity is uncertain, leave the item in the source's
`pending_urls`; do not create a guessed company key.

Qualify each selected market against its configured `scope`. For the UK
market, require explicit UK headquarters or principal operating-base evidence.
The latter must establish operational headquarters, not just a regional
operation; explicit headquarters outside the UK disqualifies the UK membership.
A UK office, incorporation record,
investor relationship, or accelerator relationship alone is insufficient.
Qualify profile relevance only when the company's documented work or market
fits the loaded profile; honor `exclude_companies` before qualifying or adding
a board. Record rejected decisions with their reason and supporting URLs.
Failure to read or verify new evidence leaves a new decision pending; it never
turns a company into a rejection. A transient failure must not downgrade a
previously qualified status: retain its verified evidence and status, record
the failed check, and report the current check as unknown.

Canonicalize configured source URLs and key `discovery.observations` by that
canonical URL, per the schema. Keep `first_seen_at` immutable. Record the
latest attempt in `last_checked_at`; advance
`last_successful_check_at` only after the source and its available pagination
were successfully inspected. Store discovered item URLs in `seen_urls` and
uninspected items in `pending_urls`. An item leaves `pending_urls` only after
its company and relevant evidence have been successfully inspected. A failed
source or item read preserves prior evidence and successful-check timestamps;
retain unfinished URLs in the queue and report the failure.

Process sources in configuration order; revisit known companies in selected
markets oldest `last_checked_at` first, including those with no careers page.
Preserve first-seen timestamps and previously captured event-date precision.
Deduplicate evidence by normalized `source_url`, `event_type`, and
`event_date`; repeated runs update the existing record instead of adding a
duplicate.
Do not claim a source is complete when pagination was inaccessible or
truncated; keep the unresolved work pending and report the run as incomplete.

## Official careers and ATS routing

Inspect the verified official company site for its careers link. A successful
inspection with no careers destination may set `careers.status: not_found`.
A failed or incomplete inspection stays `unknown`. Mark `found` only for an
official careers destination, including a valid board that currently has no
open postings; record its URL.

Materialize inputs only when profile relevance is qualified and at least one
tracked market membership is qualified. Otherwise retain research memory only.
Verify the ATS instance from that official link before extracting a tenant.
For supported Greenhouse, Ashby, and US Lever instances, add a board row to a
compatible `kind: board` pack whose `route.ats` matches the verified instance.
The board row uses the canonical company host as `company_id`, the verified
company name as `name`, the ATS board-root URL as `url`, and
`managed_by: job-company-scout`. Never use a posting URL as a board root.

If no compatible pack exists, copy that ATS's corresponding board pack from
`job-profile/templates/data/search_packs.yaml` only when its id is unused.
If no corresponding template pack exists, use a declared careers pack below;
never invent an API route. This includes US Lever in the current template.
Do not replace an incompatible route.
If the expected id is occupied incompatibly and no compatible pack exists,
report the conflict and leave the company record intact without adding a board.

For EU Lever, custom, or unsupported boards, create a
`surface: careers`, `location: keep-only` pack with `route.kind: careers`,
the verified official careers URL as `entry`, the canonical host as
pack-level `company_id`, the verified name as pack-level `company`, and
pack-level `managed_by: job-company-scout`. Use id
`careers-<normalized-host>` (lowercase host, replace non-alphanumeric runs
with `-`, trim `-`); on an id collision with a different company or
entry, add `-2`, `-3`, and so on. Reuse an existing careers pack for the same
company and entry, regardless of its id.

When a matching board row or careers pack already exists, reuse it. Maintain
only discovery-owned rows (`managed_by: job-company-scout`) and careers routes
(`managed_by: job-company-scout` on the pack); preserve operator-owned rows, packs,
and all unrelated content. Never overwrite an incompatible route and never
enable a disabled pack or board row. If successful research confirms profile
relevance is rejected, memberships are rejected in every tracked market,
or the company is explicitly excluded by the profile, disable
only its discovery-owned board rows and
careers packs. A failed or incomplete read can never trigger that disable.
When a qualified company reuses a disabled row or pack, leave it disabled and
report the exact `/job-profile packs enable <id> [<company_id>]` command.

## Stage and report

Build one surgical YAML edit that preserves comments, ordering, and every
operator-owned entry. Write it to `data/search_packs.yaml.{run token}.tmp`,
where `{run token}` is unique to this run — never the bare
`data/search_packs.yaml.tmp`, which `/job-profile` owns.
Parse the complete staged document and validate it against
`job-profile/references/schemas/schema-search-packs.md`. On write, parse, or schema failure, remove the
staging file, name the path and error, and report that nothing was written.
Before replacement, re-read `data/search_packs.yaml`; if its contents differ
from the original snapshot, remove the stage and report that the deck changed
under this run. Replace the original only when unchanged. If replacement
fails, clean up the stage and report that no write completed.

Report updated and newly added companies, market decisions and evidence,
careers status and board changes, pending URLs, failed reads, and any
incomplete pagination. The first run is a baseline; newly observed does not
mean newly founded, launched, or published. End with the affected ids enabled
for the next run, in deck order, as an exact `/job-scout <id>…` command.
If none are enabled, say so without suggesting an unselected run. Do not start it.
