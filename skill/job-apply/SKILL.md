---
name: job-apply
description: "Apply to scout-store postings with no operator in the loop: tailor the CV, fill the form from profile Facts, clear captchas and mail codes, submit and record. Use for /job-apply, apply to this posting, or confirming sent/submitted/applied. Not for scoring (job-match) or searching (job-scout)."
argument-hint: "[send <id>… | review <id>… | [<dossier>… | <url>…] [--prepared-only]]"
---

# Job application

Queues postings from `job-list` and takes them one at a time: reads the ad,
resolves the CV, fills the form by the resolution order in
`contract-screening.md`, authors prose fields under `contract-prose.md`,
clears walls, submits, and records. It never waits for the operator: only a
demand to create an account skips a posting; every other blocker no rule
clears leaves it unfinished.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve every profile path against Profile root (not CWD, not skill dir).
Unreadable Profile root, or a present but unreadable `data/cvs.yaml` → stop and
say so; an absent `data/cvs.yaml` falls back per `flow-apply.md` §3. A dossier
that will not read or parse is one posting's failure, not the run's —
`flow-apply.md` §2.

Write-set: `scout/jobs/` — a confirmed submission (`flow-record.md`), one
`posting dead` log line when the ad reads dead (`flow-apply.md` §2), or one
`submit unconfirmed` log line after an ambiguous submit (`flow-apply.md` §5) —
and `data/candidate.yaml` `screening_defaults.qa[]`, appended once per run
under `flow-learn.md`, plus its `data/candidate.yaml.{run token}.tmp`
staging sibling during atomic rename. A chained `job-resume-refine` writes
`scout/applications/{slug}/` under its own law.
`scout/applications/{slug}/plan.json` is read-only input here
(`flow-apply.md` §3 rule 0); only `job-prep` writes it.

Skill-local files: `./references/**` only.

When the operator message is explicit `sent`, `submitted`, or `applied`
confirmation, read `./references/flows/flow-record.md` now.
Otherwise read `./references/flows/flow-apply.md` now.
Load each additional reference only when that flow names it.

## References

- `./references/flows/flow-apply.md`
- `./references/contracts/contract-screening.md`
- `./references/contracts/contract-prose.md`
- `./references/formats/format-package.md`
- `./references/flows/flow-record.md`
- `./references/flows/flow-learn.md`

## Hard refuses

- State a fact no Fact file or the live ad prints, in a form value, a letter,
  or an answer; a missing part is named as not on record, never estimated
- Read a story body, or ship a `never_say` claim or a process number
- Write `cv/`, any `data/` path but `data/candidate.yaml`
  `screening_defaults.qa[]` and its `{run token}.tmp` staging sibling, or —
  before a confirmed submission — `scout/jobs/`, except the one
  `posting dead` or `submit unconfirmed` log line `flow-apply.md` appends
- Write an `answer` value, a scope guess, a password, a one-time code, or an
  authentication link into `qa[]`; only a question and an empty `answer`
  belong there
- Type, invent, persist, or reuse a password; create a password account; sign
  in as any identity but `data/basics.yaml` `email`
- Stage protected-class data: demographic and EEO questions are declined,
  never answered from a file or memory
- Wait for the operator: a wall, refusal, or empty required field
  `flow-apply.md` cannot clear leaves the posting under `### Unfinished`
- Score the posting, rank the fit, or re-judge the decision to apply
