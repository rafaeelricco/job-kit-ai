---
name: job-stories
description: "Write the interview story deck, or render it as a vetting script or S.T.A.R.T. bullets. Use when the user runs /job-stories, asks to add a story, which stories need numbers, a 90-second script, or work-experience bullets."
argument-hint: "[add | audit | script | experience]"
disable-model-invocation: true
---

# Job stories

Fill Profile root `data/stories/` from evidence, or render that deck as outbound
narrative.

Profile root: read `job-profile/references/flows/flow-resolve-root.md` now; obey it end-to-end.
Resolve every `data/*` path against Profile root (not CWD, not skill dir).
Unreadable required file under a resolved root → stop and say so.

Read `./references/flows/flow-stories.md` now.
Load each additional reference only when that flow names it.
