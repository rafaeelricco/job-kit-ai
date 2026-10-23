# Discover companies

This flow is entered only from an explicit `/job-company-scout` invocation or
a direct request to discover companies or boards. That request authorizes web
research, discovery history, and changes to discovery-owned inputs. It never
authorizes `/job-scout`, `/job-apply`, contacting companies, sending messages,
or scheduling future work.

Write-set: `data/search_packs.yaml`, its per-publication
`data/search_packs.yaml.{run token}.tmp` stage, and operational state under
`scout/runtime/company-scout/`. Listing markets and `status` are read-only.

## Read-only profile context

Read `job-profile/references/flows/flow-show.md` for its read set and the
Profile card and Constraints derivation. Load
`job-profile/references/schemas/schema-search-packs.md` as the sole schema for
the deck and discovery extension. Do not route through `job-profile/SKILL.md`
or enter its mutation flow.

## Preflight and run selection

1. Missing or malformed `data/search_packs.yaml`: stop, name the path and
   parser error, and write nothing.
2. If `discovery` is absent, read only its block from
   `job-profile/templates/data/search_packs.yaml`. Use it in memory to list or
   validate markets; stage it only when a market run is selected.
3. No market arguments is list-only: print enabled market ids and their scopes
   from the deck (or the template block), reading only the market block, not
   observation history, then wait. Do not browse, prepare an environment, or
   write.
   `status` calls the helper's status operation with the plain launcher;
   it needs no YAML dependency.
4. `all` selects every enabled market; otherwise the named ids, deduplicated,
   in file order. Before browsing or staging, reject `all` combined with ids,
   unknown or disabled ids, and a non-positive or non-integer `--batch-size`.
5. Prepare the environment, then run the coordinator operations below. Do not
   use LinkedIn session harvesting.

## Local helpers

`./scripts/scout.py` owns the SQLite queue, checkpoints, batch selection, and
publication; it publishes through `./scripts/deck.py`, which owns reading,
merging, and writing the deck. Publish only through the helper. Use helper
output rather than loading the complete `seen_urls`, `pending_urls`, or
company history into the conversation.

### Environment

Resolve Python as `python3`, then `py -3` on Windows, then `python`; it must be
3.9 or newer. Resolve script and requirements paths against this skill's
directory, not CWD. For a research invocation only, create
`scout/runtime/company-scout/venv` under Profile root when absent (its Python
is `Scripts/python.exe` on Windows, `bin/python` elsewhere), install
`./scripts/requirements.txt` with it, and check the installed `ruamel.yaml`
against the pin before reusing it. An environment or dependency failure stops
before browsing or publication; name the error and keep existing checkpoints.

```text
<python> -m venv <profile>/scout/runtime/company-scout/venv
<venv-python> -m pip install -r <skill>/scripts/requirements.txt
<venv-python> <skill>/scripts/scout.py
```

### Coordinator operations

Every call takes one JSON object on stdin and returns one on stdout. Pass
absolute script paths and the resolved absolute Profile root in place of
`<absolute-profile-root>`. Exit 1 returns `scout_error`: stop the operation,
report saved progress, and keep unfinished work. `markets` takes selected ids
or `all` alone; selection follows deck order.

1. **Inspect** reads configured sources and pending counts without writes:

   ```json
   { "op": "inspect", "profile_root": "<absolute-profile-root>", "markets": ["uk"] }
   ```

2. **Start** replays saved unpublished results, imports current pending links,
   and returns one batch; pending research takes priority over a source
   refresh. Omit `batch_size` for the helper's default; pass `refresh: true`
   only for an explicit `--refresh`, which puts source pages first within the
   same bound:

   ```json
   { "op": "start", "profile_root": "<absolute-profile-root>", "markets": ["uk"], "batch_size": 50, "refresh": false }
   ```

   Output has `run_id`, authoritative flat `tasks`, disjoint `assignments`,
   bounded `context`, and a `publication` report. Each task has `id`, `kind`
   (`item`, `source`, or `company`), `url`, selected `markets`, and `origins`.
   Assignments contain `worker_id` and `task_ids`; give each researcher only
   those tasks, the profile card/constraints, relevant context, and the
   Research and evidence / Official careers sections below. Use parallel
   researchers for non-empty assignments when available; otherwise research
   the same tasks inline. Researchers return findings and never write the
   profile or queue. Company context is a history preview with separate
   `company_history_counts`, not the stored evidence; return newly verified
   findings, not a claim of complete history.

3. **Record each result immediately** with `op: record`, `profile_root`,
   `run_id`, `task_id`, and `result`. The helper supplies trusted task URLs,
   markets, and origins; never take them from worker metadata. A result
   contains:

   | Field        | Meaning                                                                                                                                                                              |
   | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `outcome`    | `complete` for successfully verified research; `retry` for unresolved evidence; `failed` for an access/processing failure.                                                           |
   | `checked_at` | Actual attempt time as an ISO-8601 timestamp.                                                                                                                                        |
   | `companies`  | Mapping of verified official hosts to company records in the shared search-packs schema.                                                                                             |
   | `boards`     | Optional verified ATS destinations as `company_id` and board-root `url`; never individual postings.                                                                                  |
   | `error`      | Concise cause for an incomplete/failed attempt.                                                                                                                                      |
   | `page`       | For source-page tasks: `links` (discovered absolute item URLs), `next_pages` (reusable absolute pagination URLs), and `complete` (whether this page revealed the end of pagination). |

   A complete item/company result needs a verified identity, supporting
   evidence, and resolved relevance and selected-market decisions; otherwise
   it stays pending. When an item page verifiably names no company (an
   opinion piece, a fund recap), record `complete` with empty `companies` so
   the link is retired instead of retried forever. Save every reusable
   continuation in `next_pages`. With no
   durable pagination URL, leave coverage incomplete so a later run restarts
   and deduplicates; never invent a cursor or report completion. The helper
   computes source-wide completion from the saved frontier, not a worker's
   page flag.

4. **Publish** after recording each returned result:

   ```json
   { "op": "publish_pending", "profile_root": "<absolute-profile-root>", "markets": ["uk"] }
   ```

   Output includes `published` and `errors`. On a publication error, stop the
   research round and report earlier publications separately. Checkpoints are
   durable before publication, so a run that stops after replacing the YAML
   is replayed idempotently by the next start without repeating research.

5. **Status** reads saved counts without creating an environment or database:

   ```json
   { "op": "status", "profile_root": "<absolute-profile-root>" }
   ```

   Counters cover pending, awaiting publication, published, failed, attempted,
   and pending source/company progress. Before the first research run there is
   no operational state, so report the zero counters and say research has not
   run yet. Do not run inspect here: it needs the research environment, which
   `status` never creates.

Repeating the market invocation resumes unfinished research; interrupted or
unrecorded tasks stay pending with no lease timeout or manual unlock. The
helper orders work: a failed task is tried at most once per run, and once the
backlog is consumed a refresh cycle revisits sources and known companies
(including those with no careers page), oldest `last_checked_at` first. Every
listing page, research link, and company review counts against one batch limit;
reaching it is partial progress, not proof of coverage, and schedules nothing.
Deduplicating a URL keeps every source/market association; one market's
research does not complete another's qualification. New articles about a known
company can still add evidence.

## Research and evidence

Keep an auditable record per observed company with evidence URLs. Keep event
dates in the precision reported (`2025`, `2025-04`, `2025-04-18`); never manufacture precision. News
research keeps publication dates; portfolio observation dates are not founding
dates.

Company identity is its verified official website host, lowercased with leading
`www.` removed. Verify the website from a reliable source, then the name and any
rebrand aliases against official company evidence. Store `website` as
published, not rewritten to the key. Investor, accelerator, and ATS tenant hosts
are not identity. If host or identity is uncertain, leave the item in
`pending_urls`; never guess a company key.

Qualify each selected market against its `scope`. Every market requires
explicit headquarters or principal operating-base evidence inside its
territory: `uk` is the United Kingdom, `us` the United States, `eu` the
European Union member group in `job-profile/scripts/geography.json` (the United
Kingdom is not a member); other ids take territory from `scope`. The evidence
must establish operational headquarters; a regional operation, local office,
incorporation (including US-state incorporation of a company run elsewhere),
investor, or accelerator relationship alone is insufficient, and explicit
headquarters outside the territory disqualifies.
Qualify relevance only when the company's documented work or market fits the
Profile card and Constraints; honor `exclude_companies` before qualifying or
adding a board. Record rejections with reason and supporting URLs. A failed read or verification
leaves a new decision pending, never a rejection, and never downgrades a
previously qualified status: keep its evidence and status, record the failed
check, and report the current check as unknown.

Observation bookkeeping follows the schema: source URLs canonicalized and used
as `discovery.observations` keys; `first_seen_at` and captured date precision
immutable; `last_checked_at` is the latest attempt; `last_successful_check_at`
advances only after the source and its available pagination were inspected.
Discovered items go to `seen_urls`, uninspected ones to `pending_urls`, which
an item leaves only after its company and evidence were inspected. A failed
read keeps prior evidence and success timestamps and its URLs queued. Evidence
deduplicates on normalized `source_url`, `event_type`, and `event_date`.
Never claim a source complete when pagination was inaccessible or truncated;
keep the work pending and report the run incomplete.

## Official careers and ATS routing

Inspect the verified official site for its careers link. `careers.status:
found` only for an official careers destination (a valid board with no open
postings counts), with its URL; `not_found` only after a successful inspection
found none; `unknown` for a failed or incomplete inspection. Verify the ATS
instance from that official link before extracting a tenant; report boards as
board-root URLs, never postings.

Publication materializes inputs only when relevance and at least one tracked
market membership are qualified; otherwise it keeps research memory only.
Supported Greenhouse, Ashby, and US Lever boards become
`managed_by: job-company-scout` rows in a compatible `kind: board` pack whose
`route.ats` matches, else in that ATS's template pack, copied only when its id
is unused. If no corresponding template pack exists, use a declared careers
pack (US Lever today); EU Lever, custom, and unsupported boards do the same,
as a discovery-owned `careers-<host>` pack. The helper reuses matching rows
and packs, preserves operator-owned content, never replaces an incompatible
route, never invents an API route, and never enables a disabled row or pack. On
confirmed rejection of relevance, of every tracked market, or by profile
exclusion, it disables only discovery-owned rows and packs; a failed or
incomplete read never does. Report an occupied, incompatible template pack id
as a conflict: the company record stays, without a board.

When a qualified company reuses a disabled row or pack, leave it disabled and
report the exact enable command: `/job-profile packs enable <pack id> <company_id>`
for a reused `boards[]` row, or `/job-profile packs enable <pack id>` for a
reused careers pack. Never add a `company_id` to a careers pack's command;
`packs enable` reads a second argument as a `boards[]` row.

## Publication and report

`publish_pending` stages each result at `data/search_packs.yaml.{run token}.tmp`
(never the bare `.tmp`, which `/job-profile` owns), validates it against the
schema, and replaces the deck only if it is unchanged since the snapshot,
preserving comments, order, operator-owned entries, and market/source
configuration. On a stage, parse, schema, changed-deck, or replacement failure
the stage is removed and the result stays awaiting publication; report the
error.

Report attempted, completed, failed, awaiting-publication, and remaining work;
new and updated companies with market decisions and evidence; careers status
and board/careers-input changes; pending URLs, failed reads, and incomplete
pagination. Relay every command in a publication summary's `enable_commands`
verbatim; each names a disabled pack that received this run's board row or
careers route. The first run is a baseline: newly observed does not mean newly
founded, launched, or published. End with the affected enabled ids, in deck
order, as an exact `/job-scout <id>…` command; if none are enabled, say so
without suggesting an unselected run. Do not start it.
