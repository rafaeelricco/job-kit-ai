# Match — graph

Main does not score a job.

Write-set: none. Direct calls return chat only; worker and state JSON stay in-session
or in one run-scoped temp directory outside Profile root, removed after **report**.

Reader law: `job-store/references/flows/flow-read.md`.

Store source (below) and the store is absent or unreadable → name the path and end. A pasted posting (rule 1) does not need the store.

```
bind → profile → candidates → eligibility → score → order → select → advise → report
```

## bind

Load `./references/schemas/schema-state.md` and `./references/contracts/contract-match.md` (the policy; never spawn a criteria agent). Init state: `candidate` null, empty lists, `evidence_sources` and `resume_evidence` empty arrays.

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

Store selectors (rules 2–4) run `job-store/scripts/slice_store.py` once with
`{"root", "select", "exclude"}`. Keep its `filter` and `excerpts` in the
run-local workspace, paired by dossier filename. Copy its `gaps` to
`state.gaps`. If the named dossier is unparseable, stop and name it.
Zero dossiers → `No dossiers to match.` and end.

## Eligibility

For store sources, run MatchingPolicy's eligibility filters on the `filter` rows
and CandidateProfile. Record the first hit in `state.blocked` and pass only
the surviving excerpts to scoring. For a pasted posting, run those same filters
on the JobProfile after extraction, before the required language filter.

## score

Load `./references/flows/flow-score.md` for the launcher and the shared extraction,
language filter, matching, scoring, and review steps. Keep the resulting JobProfiles
and MatchResults in `state.jobs` and `state.matches`.

Review a row when `match_score >= 75`, it carries a `match_uncertain` list, or
`confidence < 0.7` and `match_score >= 60`. Send language blocks to `state.blocked`.
For an initial TypeSafe invocation failure, print its `match_error` or stderr
if stdout is not JSON, and end. If every row returned `match_error`, print the
first error and end. Otherwise send failed rows to `state.gaps` and continue.

## order

Order valid matches by final `match_score` descending. Preserve candidate order
for equal scores.

## select

Apply `--top <n>` after validation and ordering. With no modifier, retain every
valid match. Only retained rows at or above `possible_match` proceed to advise;
the rest are reported without guidance.

## advise

For the selected JobProfiles, run `./scripts/scaffold_guidance.py` with
`{"candidate", "jobs"}` on stdin. Build the trusted source inventory from
canonical `experiences.yml` `summary[]`, optional `projects.yml` `description[]`,
and profile skills. Include all achievements with exact text and locations.
Keep this inventory out of CandidateProfile, scoring, review, and TypeSafe.

Load `./references/contracts/contract-resume-guidance.md` and
`./references/contracts/contract-resume-evidence.md`. Load
`./references/workers/worker-resume-match.md` with the two worker references it
uses. Build one trusted evidence case per selected job. Assign requirement IDs
R1.. in required-then-preferred order
without deduplicating. Use the job URL or `posting:<ordinal>` as the evidence
target, and set `cv_assessed` false. The scaffold keeps the JobProfile's URL,
including the empty string for a posting without one.

Dispatch one worker per batch using the shared scoring flow's batching rules.
The slice contains CandidateProfile and paired JobProfiles, scaffolds, and
evidence cases. Omit MatchResults and posting excerpts. If scaffolding fails,
record a guidance gap and still send the evidence cases.

Validate each returned array independently. Run `./scripts/validate_guidance.py`
with `{"candidate", "jobs", "guidance"}` and `./scripts/resume_evidence.py`
with `{"cases", "assessments"}`. For a missing or malformed array, record that
half as unavailable and validate the other. Record valid rows in
`state.guidance` or `state.resume_evidence`. Record invalid or missing rows as
gaps with URL or path and reason. Keep the scored match and any valid peer output.

## report

Use the prompt scaffold when supplied. Otherwise retain title, company, URL,
and first strength, then, for rows advise covered, add held requirements, requirements not evidenced by
the thin match profile, unresolved requirements, and exact priority roles.
Add achievement citations and primary next actions. Each link must include an exact source field location (file, role/project identifier, field index) and a verbatim contiguous excerpt from validated sources, inline or in a source legend. Do not ellipsize quoted text or cite only an employer/source ID. Verify these citations before sending the final report.

Thin-profile held/not_evidenced/unknown stays separately labeled and is not overridden by narrative evidence. CV visibility remains unassessed. Report only actual script-computed scores; do not add hypothetical scores or hand-calculated score gains. Missing/invalid richer evidence preserves the old report and states `Achievement evidence unavailable`. Invalid guidance prints `Resume guidance unavailable`. Keep raw worker/state JSON hidden and cleanup within the existing temp lifecycle. End.
