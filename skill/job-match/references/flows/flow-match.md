# Match — graph

Main does not score a job.

Write-set: none. Direct calls return chat only; worker and state JSON stay in-session
or in one run-scoped temp directory outside Profile root, removed after **report**.

Reader law: `job-store/references/flows/flow-read.md`.

Store source (below) and the store is absent or unreadable → name the path and end. A pasted posting (rule 1) does not need the store.

```
bind → profile → candidates → filter₁ → extract → filter₂ → match → score
                                                              │
report ◄─ advise ◄─ select ◄─ order ◄─ validate ◄──────────────┘
```

Fan-out only on extract, match, validate, and advise. Batch ~10 when the harness can spawn a worker; else inline sequential. A node with 3 rows or fewer
runs inline even when spawning works — except validate, which spawns whenever it
can so the review stays independent of the pass that wrote the row.
Hand each worker one slice file in the run directory — exactly its batch, plus
the same `state.candidate` for match, validate, and advise — and the paths of the worker and contract files it obeys. Never paste JSON
into a brief. Spawn each worker as agent type `job-kit-worker` when the harness
offers it, else the default type. Main runs every script.

## bind

Load `./references/schemas/schema-state.md` and `./references/contracts/contract-match.md` (the policy; never spawn a criteria agent). Init state: `candidate` null, empty lists.

## profile

Derive `state.candidate` per schema-state CandidateProfile. Unreadable required file → stop and name it.
`data/job_search.yaml` with a valued `locations`, `location_scope`, `exclude_locations`, `screening_defaults`, or `work_authorization` key → stop; migrate via `/job-profile`.
Presence of `location.also_eligible_from` or `direct_regions`, including empty values, → stop; migrate via `/job-profile`.
Load `job-profile/references/contracts/contract-geography.md`; missing or unresolved `data/basics.yaml` `country` → stop; run `/job-profile continue fill basics.country`.

## candidates

Parse tokens. At most one selector: `all` | one `scout/jobs/` filename; a
pasted posting needs none (rule 1). `--exclude <status>[,<status>…]` is a modifier; it
consumes the next token. `--top <n>` consumes one positive integer and is legal
with every selector. `--typesafe` takes no value, is legal
with every selector, and switches **match** to TypeSafe; with `TYPESAFE_API_KEY`
unset or empty, stop and name it. Status vocabulary =
`job-store/references/flows/flow-read.md` frontmatter `status:`. Missing, non-integer,
non-positive, or repeated `--top` values, or a repeated `--typesafe` → stop. Unknown status, `--exclude`
with a pasted posting or a dossier, an unmatched `.md` filename, unknown flags,
leftover tokens, or two selectors → stop.

1. No selector and the message already holds a posting body (role text or structured facts — not a lone company/title token) → one candidate: that body. Never fetch.
2. A dossier filename → `select` = that file under `scout/jobs/`. Use its stored
   snapshot, never fetch; status and dead-log filters do not apply.
3. `all`, or `--exclude` with no selector → `select: "all"`: every parseable dossier except `dropped` and dead-by-log, minus `--exclude` statuses.
4. Empty → `select: "new"`: frontmatter `status:` = `new`, not dead-by-log, minus `--exclude` statuses.

Store selectors (rules 2–4) run `job-store/scripts/slice_store.py` (same launcher as
**score**) with `{"root", "select", "exclude"}`; it applies those filters. Its `filter` rows are the Posting facts
filter₁ reads, and its `gaps` go to `state.gaps`. A rule 2 dossier that lands in `gaps`
is unparseable: stop and name it.

Zero → `No dossiers to match.` and end.
Pasted posting: run **extract** before **filter₁**. Store sources keep the graph order.

## filter₁

Main. Contract hard filters 1–7 on Posting facts + frontmatter `company` / `title` + `state.candidate`. Pasted posting (no Posting facts table): the JobProfile's `company` / `title` / `location` / `work_model` / `work_auth` / `hiring_route` / `eligibility` / `salary`. First hit → `state.blocked`. Do not score.

## extract

Load `./references/workers/worker-extract.md`. Store sources: rerun `job-store/scripts/slice_store.py` with `skip` = the rows filter₁ blocked, `out` = the run directory, and `batch` = 10, and hand each extract worker one batch file. Pasted posting: hand over the supplied body. Write `state.jobs[]`. Malformed → `state.gaps`.

## filter₂

Main. Contract HF8 on JobProfile + `state.candidate`. Hit → move to `state.blocked`, drop from `state.jobs`.

## match

`--typesafe` → run `./scripts/typesafe_match.py` (same launcher as **score**)
instead of the worker, with `{"candidate": state.candidate, "jobs": state.jobs}`
on stdin. It sends that CandidateProfile and each JobProfile to
`api.typesafe.ai`. Non-zero exit → print its
`match_error`, or its stderr when stdout is not JSON, and end. Every row
carrying `match_error` → print the first one and end. Otherwise a row carrying
`match_error` → `state.gaps` and drop it; write the rest to `state.matches[]`.
A cell TypeSafe answered below its confidence floor arrives as `null` — the
contract's `—` — so **score** lowers that row's `confidence` and **validate**
re-checks it. An uncertain answer is never scored `0`.

Otherwise, load `./references/workers/worker-match.md`; each worker gets its JobProfile batch, no dossier prose.
Write `state.matches[]`. Malformed → `state.gaps`.

## score

Main. Resolve `./scripts/score.py` from the loaded job-match skill root. Resolve
the first working Python 3 launcher: `python3`; on Windows, `py -3`; otherwise
`python` only when its reported major version is 3. Missing launcher or unreadable
scorer → name the dependency and end.

Run the resolved launcher and absolute scorer path with one JSON object on
stdin: `{"candidate": state.candidate, "jobs": state.jobs, "matches": state.matches}`.
It returns the matches array scored per the contract, with unquoted `strengths` / `gaps` / `blockers`
items moved to `evidence_dropped`.
A row carrying `score_error` → `state.gaps` and drop that row; a row carrying
`evidence_dropped` → note those items in `state.gaps` and keep the row.

## validate

Load `./references/workers/worker-validate.md`. Rows with `match_score >= 75`, rows that carry a
`match_uncertain` list, and rows with `confidence < 0.7` and `match_score >= 60` after score are
selected once.
Each worker's slice carries the MatchResult currently in `state.matches`. `APPROVED` leaves the row; `CORRECTION_REQUIRED` replaces it, and a replaced row goes back through **score** before order.
Malformed or failed validate output → `state.gaps` and drop the row.
Non-reviewed rows stay as match wrote them.

## order

Order valid matches by final `match_score` descending. Preserve candidate order
for equal scores.

## select

Apply `--top <n>` after validation and ordering. With no modifier, retain every
valid match. Only retained rows at or above `possible_match` proceed to advise;
the rest are reported without guidance.

## advise

Run `./scripts/scaffold_guidance.py` (same launcher as **score**) with
`{"candidate": state.candidate, "jobs": <selected JobProfiles>}` on stdin; it
emits one ResumeGuidance skeleton per job. Load `./references/contracts/contract-resume-guidance.md` and
`./references/workers/worker-resume-guidance.md`. Pass CandidateProfile, selected JobProfiles, the
skeletons, and the Skill hold law—never dossier prose or MatchResult claims.
Validate the batch with `./scripts/validate_guidance.py`. Add valid rows to
`state.guidance`; add invalid rows to `state.gaps` without dropping their match.

## report

Use the prompt scaffold when supplied. Otherwise retain title, company, URL,
and first strength, then, for rows advise covered, add held requirements, requirements not evidenced by
the thin match profile, unresolved requirements, and exact priority roles.
Invalid guidance prints `Resume guidance unavailable`; raw worker/state JSON
stays hidden. End.
