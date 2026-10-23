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
   Do not browse, prepare an environment, or write. Read only the market block,
   not the observation history. `status` calls the helper's read-only status
   operation with the existing Python launcher; it needs no YAML dependency.
4. `all` selects every enabled market. Otherwise select the named market ids,
   deduplicated and processed in file order. Reject `all` combined with ids,
   unknown ids, and disabled ids before browsing or staging a write.
5. Prepare the isolated Python environment below, then use `./scripts/scout.py`
   to reconcile saved results and select one bounded batch. Existing pending
   research takes priority over starting a source refresh. `--batch-size N`
   overrides the helper's default; reject non-positive or non-integer values.
   `--refresh` prioritizes source pages within the same batch bound.
   Research workers receive disjoint tasks and the relevant profile context;
   the coordinator records each returned result before publication.
   Source pages and pagination are queued work with persisted progress.
   News research preserves publication dates; portfolio observation dates
   are not founding dates. Interrupted work remains pending. Do not use
   LinkedIn session harvesting.

## Local helpers and bounded research

Code lives in this skill; runtime data lives under the resolved Profile root.
`./scripts/scout.py` owns the SQLite queue and checkpoints;
`./scripts/deck.py` owns reading and publishing the search deck. Use the helper
output rather than loading the complete `seen_urls`, `pending_urls`, or company
history into the conversation.

### Environment

Resolve Python as `python3`, then `py -3` on Windows, then `python`, checking
that the chosen interpreter is Python 3.9 or newer. Resolve the script and
requirements paths against this skill's directory, not CWD. For a research
invocation only, create a virtual environment at
`scout/runtime/company-scout/venv` under Profile root when absent. Its Python
is `Scripts/python.exe` on Windows and `bin/python` elsewhere. Use that Python
to install `./scripts/requirements.txt` and run the helper. Check the installed
`ruamel.yaml` version against the pinned requirement before reusing the
environment. An environment or dependency failure stops before browsing or
deck publication; name the error and preserve existing checkpoints.

For example, with absolute paths substituted:

```text
<python> -m venv <profile>/scout/runtime/company-scout/venv
<venv-python> -m pip install -r <skill>/scripts/requirements.txt
<venv-python> <skill>/scripts/scout.py
```

`status` uses the original launcher and does not initialize or install anything.

### Coordinator operations

Every helper call takes one JSON object on stdin and returns one JSON object
on stdout. Use absolute Profile-root and script paths. Exit 1 returns
`scout_error`; stop the operation, report saved progress, and retain unfinished
work. The `markets` list accepts selected ids or `all` alone; selection follows
deck order. Replace `<absolute-profile-root>` in every example with the resolved
absolute Profile root on the current machine, such as `/Users/candidate/profile`
on macOS or `C:/profiles/candidate` on Windows. Do not pass the placeholder itself.

1. **Inspect** reads configured sources and pending counts without writes:

   ```json
   { "op": "inspect", "profile_root": "<absolute-profile-root>", "markets": ["uk"] }
   ```

2. **Start** replays saved unpublished results, imports current pending links,
   and returns one batch. Omit `batch_size` for the helper's default; pass
   `refresh: true` only for an explicit refresh request:

   ```json
   { "op": "start", "profile_root": "<absolute-profile-root>", "markets": ["uk"], "batch_size": 50, "refresh": false }
   ```

   Output has `run_id`, authoritative flat `tasks`, disjoint `assignments`,
   bounded `context`, and a `publication` report. Each task has `id`, `kind`
   (`item`, `source`, or `company`), `url`, selected `markets`, and `origins`.
   Assignments contain `worker_id` and `task_ids`; give each researcher only
   those tasks, the shared profile card/constraints, relevant context, and the
   Research and evidence / Official careers and ATS routing rules below.
   Use available parallel researchers for non-empty assignments only;
   otherwise research those same tasks inline. Researchers return findings
   and never write the profile or queue.
   Company context is a history preview with separate `company_history_counts`;
   it does not replace the stored evidence. Return newly verified findings,
   not a claim that the preview represents the company's complete history.

3. **Research and record one result immediately.** The record call includes
   `op: record`, `profile_root`, `run_id`, `task_id`, and `result`. The helper
   supplies trusted task URLs, markets, and origins; do not take them from
   worker-supplied metadata. A result contains:

   | Field        | Meaning                                                                                                                                                                              |
   | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `outcome`    | `complete` for successfully verified research; `retry` for unresolved evidence; `failed` for an access/processing failure.                                                           |
   | `checked_at` | Actual attempt time as an ISO-8601 timestamp.                                                                                                                                        |
   | `companies`  | Mapping of verified official hosts to company records in the shared search-packs schema.                                                                                             |
   | `boards`     | Optional verified ATS destinations as `company_id` and board-root `url`; never individual postings.                                                                                  |
   | `error`      | Concise cause for an incomplete/failed attempt.                                                                                                                                      |
   | `page`       | For source-page tasks: `links` (discovered absolute item URLs), `next_pages` (reusable absolute pagination URLs), and `complete` (whether this page revealed the end of pagination). |

   A complete item/company result requires a verified identity, supporting
   evidence, and resolved relevance/selected-market decisions. Failure to
   establish them remains pending. When an item page verifiably names no
   company (an opinion piece, a fund recap), record `complete` with empty
   `companies` so the link is retired instead of retried forever. Use a source result's `next_pages` to save
   every reusable continuation. If a surface has no durable pagination URL,
   retain incomplete coverage so a later run can restart and deduplicate;
   never invent a cursor or report completion. The coordinator computes
   source-wide pagination completion from the saved frontier, rather than
   trusting a worker's page flag alone.

4. **Publish** after recording each returned result:

   ```json
   { "op": "publish_pending", "profile_root": "<absolute-profile-root>", "markets": ["uk"] }
   ```

   Output includes `published` and `errors`. Stop the research round on a
   publication error; report any earlier publications separately. A checkpoint
   is durable before publication. If the run stops after replacing the YAML
   but before acknowledging the checkpoint, the next start replays it
   idempotently without repeating web research.

5. **Status** reads saved counts without creating an environment or database:

   ```json
   { "op": "status", "profile_root": "<absolute-profile-root>" }
   ```

   Counters include pending, awaiting publication, published, failed, attempted,
   and pending source/company progress. Before the first research run there
   is no operational state, so report the zero counters and say research has
   not run yet. Do not run inspect here: it needs the research environment,
   which `status` never creates.

Repeating the market invocation resumes unfinished research. Tasks without a
recorded result remain pending; no lease timeout or manual unlock is required.
Failed tasks go behind unattempted items and are tried at most once in a run.
Round-robin source selection prevents a large portfolio from monopolizing a
batch. Preserve every source/market association when a URL is deduplicated;
researching one market does not complete another market's qualification.
Different articles about an already known company can still add evidence.

After the backlog is consumed, start a source-refresh cycle and revisit known
companies oldest-check-first, including those with no careers page. Existing
unfinished refresh work resumes rather than restarting source pagination.
Each listing page, research link, and company review counts against the same
batch limit. Reaching the limit ends this invocation with partial progress;
it is not proof of complete source coverage and does not schedule another run.

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

Qualify each selected market against its configured `scope`. Every market
requires explicit headquarters or principal operating-base evidence inside its
territory: `uk` is the United Kingdom, `us` is the United States, and `eu` is
the European Union member group in `job-profile/scripts/geography.json` (the
United Kingdom is not a member). Any other market id takes its territory from
`scope`. The operating-base evidence must establish operational headquarters,
not just a regional operation; explicit headquarters outside the territory
disqualifies that membership. A local office, incorporation record (including
a US-state incorporation for a company run elsewhere), investor relationship,
or accelerator relationship alone is insufficient.
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

The helper retains source configuration order for fair selection and revisits
known companies in selected markets oldest `last_checked_at` first, including
those with no careers page, when the refresh cycle reaches that work.
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
report the exact enable command: `/job-profile packs enable <pack id> <company_id>`
for a reused `boards[]` row, or `/job-profile packs enable <pack id>` for a
reused careers pack. Never add a `company_id` to a careers pack's command;
`packs enable` reads a second argument as a `boards[]` row.

## Stage and report

Publish each checkpointed result through `./scripts/deck.py`, preserving
comments, ordering, operator-owned entries, and market/source configuration.
Stage each publication at `data/search_packs.yaml.{run token}.tmp`,
where `{run token}` is unique to this publication — never the bare
`data/search_packs.yaml.tmp`, which `/job-profile` owns.
Parse the complete staged document and validate it against
`job-profile/references/schemas/schema-search-packs.md`. On write, parse, or schema failure, remove the
staging file and leave that result awaiting publication. Report the error and
distinguish earlier published items from this unpublished item.
Before replacement, re-read `data/search_packs.yaml`; if its contents differ
from the original snapshot, remove the stage and report that the deck changed
under this run. Replace the original only when unchanged. If replacement
fails, clean up the stage and report that this publication did not complete.

Report attempted, completed, failed, awaiting-publication, and remaining work,
along with new/updated companies and careers inputs. Saved results are replayed
before selecting new research. Batch exhaustion is partial progress; source
success timestamps advance only when the saved pagination frontier is complete.

Report updated and newly added companies, market decisions and evidence,
careers status and board changes, pending URLs, failed reads, and any
incomplete pagination. Relay every command in a publication summary's
`enable_commands` verbatim; each names a disabled pack that received this run's
board row or careers route. The first run is a baseline; newly observed does not
mean newly founded, launched, or published. End with the affected ids enabled
for the next run, in deck order, as an exact `/job-scout <id>…` command.
If none are enabled, say so without suggesting an unselected run. Do not start it.
