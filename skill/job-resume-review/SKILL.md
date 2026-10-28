---
name: job-resume-review
description: "Score a resume or CV and give a recruiter read from the CV, and LinkedIn when supplied. Add job alignment when a posting is supplied; career level, search visibility, and public work on request. Use for CV reviews, quality scores, or level and role fit."
argument-hint: "[<cv>] [--with <posting|dossier>] [--linkedin <url|paste>]"
---

# Job resume review

Review one CV for quality, level, and role fit, and return the evaluation in chat.

Skill-local files: `./references/**` and `./scripts/*.py` only. Resolve both
against the directory containing this loaded `SKILL.md`, never the caller's
CWD.

Read `./references/flow-job-resume-review.md` now.
Load each additional reference only when that flow names it.
