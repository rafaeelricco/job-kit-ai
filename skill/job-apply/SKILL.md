---
name: job-apply
description: "Apply to scout-store postings with no operator in the loop: tailor the CV, fill the form from profile Facts, clear captchas and mail codes, submit and record. Use for /job-apply, apply to this posting, or confirming sent/submitted/applied."
argument-hint: "[send <id>… | review <id>… | [<dossier>… | <url>…] [--prepared-only]]"
---

# Job application

Applies to queued postings one at a time, from reading the ad to a recorded submission, with no operator in the loop.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve every profile path against Profile root (not CWD, not skill dir).
Unreadable Profile root, or a present but unreadable `data/cvs.yaml` → stop and
say so; an absent `data/cvs.yaml` falls back per `flow-apply.md` §3.
`data/candidate.yaml` present → stop; migrate via `/job-profile`.

## Writes

A run writes these and nothing else. Before a confirmed submission,
`scout/jobs/` takes only the two log lines. The `pending[]` step runs at the
end of every run, whether or not it recorded a submission.

| When                                         | Writes                                                              | Where                                                  | Dossier-less `<url>` |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ | -------------------- |
| Ad reads dead (`flow-apply.md` §2)           | one `posting dead` line                                             | its dossier                                            | nothing              |
| Ambiguous submit (`flow-apply.md` §5 step 9) | `- {YYYY-MM-DD} · submit unconfirmed: ambiguous result — job-apply` | its dossier                                            | nothing              |
| Confirmed submission (`flow-record.md`)      | `status:`, log line, final package                                  | its dossier                                            | creates it           |
| End of run (`flow-learn.md`)                 | unanswered labels                                                   | `data/answers.yaml` `pending[]`, via `{run token}.tmp` | —                    |

Each of the two log lines is appended under the `job-store/references/contracts/contract-persistence.md`
lock, exactly one line below the ownership marker, touching nothing else — not
`status:`, not the body. Never create a dossier to hold a log line.
A chained `job-resume-refine` writes `scout/applications/{slug}/` under its own
law. `scout/applications/{slug}/plan.json` is read-only input
(`flow-apply.md` §3 rule 0); only `job-prep` writes it.

Skill-local files: `./references/**` only.

When the operator message is explicit `sent`, `submitted`, or `applied`
confirmation, read `./references/flows/flow-record.md` now.
Otherwise read `./references/flows/flow-apply.md` now.
Load each additional reference only when that flow names it.

## Hard refuses

- State a fact no Fact file or the live ad prints, in a form value, a letter,
  or an answer; a missing part is named as not on record, never estimated
- Read a story body, or ship a `never_say` claim or a process number
- Write anything `## Writes` does not list
- Write `qa[]`, an answer, a scope guess, a password, a one-time code, or an
  authentication link; only a question, source, and date belong in `pending[]`
- Type, invent, persist, or reuse a password; create a password account; sign
  in as any identity but `data/basics.yaml` `email`
- Stage protected-class data: demographic and EEO questions are declined,
  never answered from a file or memory
- Wait for the operator: a wall, refusal, or empty required field
  `flow-apply.md` cannot clear leaves the posting under `### Unfinished`
- Score the posting, rank the fit, or re-judge the decision to apply
