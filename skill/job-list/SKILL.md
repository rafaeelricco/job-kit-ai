---
name: job-list
description: "Inspect dossiers already on disk under scout/jobs/. Read-only. Use when the user asks what jobs do I have, which applications are open, or what scout saved."
---

# Job list

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve `scout/` against that root, not session CWD, not skill dir.

Print `Store: {root}/scout/jobs/` before answering.
`scout/` or `scout/jobs/` absent → say no dossiers have persisted yet and stop;
creating them is job-scout persist. Present but unreadable → stop and name the
path.

1. Load `job-store` (reader law). Read `./references/formats/format-views.md` now, and glob
   `scout/jobs/` in parallel; obey flow-read.md end-to-end.
2. Print `score`, `bucket`, and posting facts as they sit on disk. Never re-score,
   never re-derive `bucket`, never open a posting URL to refresh a field.
3. Unparseable file under `scout/jobs/` → name it under Gaps and keep going. Never
   guess its fields, never repair it.
4. Deliver per the view shape already loaded.

## References

- `job-store/references/flows/flow-read.md`
- `./references/formats/format-views.md`
