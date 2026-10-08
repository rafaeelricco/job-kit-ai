---
name: job-inbox
description: "Check Gmail for replies to tracked applications and write lifecycle status onto existing scout/jobs/ dossiers when evidence is strong. Reads mail only. Use when the user runs /job-inbox, asks if anyone replied, check application email, update status from inbox, or scan for interview / rejection / offer mail."
argument-hint: "[all | <company> | <title> | <dossier>…]"
---

# Job inbox

Load `job-profile-root`. Resolve `scout/` and `data/*` against Profile root
(not CWD, not skill dir). Unreadable required file → stop and say so.

Store law: load the `job-store` skill now; obey it end-to-end.

Skill-local: `./references/**` only.

Read `./references/flows/flow-inbox.md` now.
Load each additional reference only when that flow names it.
