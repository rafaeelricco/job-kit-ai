---
name: job-list
description: "Inspect dossiers already on disk under scout/jobs/. Read-only. Use when the user asks what jobs do I have, which applications are open, or what scout saved."
---

# Job list

Answer questions about the dossiers scout already persisted, read-only.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve `scout/` against that root, not session CWD, not skill dir.

Skill-local files: `./references/**` only.

Read `./references/flows/flow-job-list.md` now.
Load each additional reference only when that flow names it.
