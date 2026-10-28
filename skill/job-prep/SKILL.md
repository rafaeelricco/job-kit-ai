---
name: job-prep
description: "Prepare application packages offline for hot dossiers: revalidate the ad, resolve form fields against profile Facts, chain job-resume-refine, write plan.json and package.md; digest shows what is ready. Use for /job-prep, a nightly prep cron, or a morning digest cron."
argument-hint: "[digest | from-match | <dossier>… | --ats [<family>[,…]]] [--channel ats|dm_request|direct_email|founder] [--top <n>]"
disable-model-invocation: true
---

# Job prep

Prepares application packages; never posts.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve every profile path against Profile root (not CWD, not skill dir).
`data/candidate.yaml` present → stop; migrate via `/job-profile`.

Skill-local files: `./references/**` only.

Read `./references/flows/flow-prep.md` now.

Load each additional reference only when that flow names it.
