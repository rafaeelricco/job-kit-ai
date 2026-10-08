---
name: job-resume-review
description: "Score a resume or CV and judge which career level and roles it supports, using the CV and public professional evidence. Add job alignment when a posting is supplied. Use for CV reviews, quality scores, or level and role fit."
argument-hint: "[<CV file or pasted content>] [with <posting or dossier>]"
---

# Job resume review

Review one CV for quality, level, and role fit, and return the evaluation in chat.

Skill-local files: `./references/**` and `./scripts/*.py` only. Resolve both
against the directory containing this loaded `SKILL.md`, never the caller's
CWD.

Read `./references/flow-job-resume-review.md` now.
Load each additional reference only when that flow names it.
