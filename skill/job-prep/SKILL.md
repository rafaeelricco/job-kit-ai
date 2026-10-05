---
name: job-prep
description: "Prepare application packages offline for hot dossiers: revalidate the ad, resolve form fields against profile Facts, chain job-resume-refine, write plan.json and package.md; digest shows what is ready. Use for /job-prep, a nightly prep cron, or a morning digest cron. Not for submitting (job-apply)."
argument-hint: "[digest | from-match | <dossier>… | --ats [<family>[,…]]] [--channel ats|dm_request|direct_email|founder] [--top <n>]"
---

# Job prep

Prepares, never posts. `job-apply/references/flows/flow-apply.md` §§2–4 run here;
§5 does not exist in this skill. `digest` is read-only and opens no browser.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve every profile path against Profile root (not CWD, not skill dir).
`data/candidate.yaml` present → stop; migrate via `/job-profile`.

Write-set: `scout/applications/{slug}/` — `plan.json`, `package.md`, and the
chained `job-resume-refine`'s own outputs — plus one `posting dead` log line on
a `scout/jobs/` dossier whose ad reads dead (`flow-prep.md` §2). Never
`status:`, never the scout-owned body. `data/` and `cv/` are read-only; the
dossier stays `status: new` until `job-apply/references/flows/flow-record.md` runs.

Skill-local files: `./references/**` only.

Read `./references/flows/flow-prep.md` now.

## References

- `./references/flows/flow-prep.md`
- `./references/schemas/schema-plan.md`
- `./references/ats/ats-greenhouse.md`
- `./references/ats/ats-lever.md`
- `./references/ats/ats-ashby.md`

## Hard refuses

- Click any control that posts, saves, or creates an account — "Save draft" and
  "Continue" past the last read-only step included
- Write `data/` or `cv/`; write `scout/jobs/` beyond the one `posting dead` log
  line §2 appends — never `status:`, never the body
- Author a cover letter, message, essay, or composed free-text answer
- Emit a plan for a posting whose ad did not read this run
- Sign in, create an account, or solve a captcha or bot check; record an
  apply-path wall per `flow-prep.md`, never clear it
