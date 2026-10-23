# Job list — flow

1. Print `Store: {root}/scout/jobs/` before answering. `scout/` or `scout/jobs/`
   absent → say no dossiers have persisted yet and stop; creating them is
   job-scout persist. Present but unreadable → stop and name the path.
2. Read `./references/formats/format-views.md` and glob `scout/jobs/`.
3. Print `score`, `bucket`, and posting facts as they sit on disk. This skill is
   read-only: no re-score, no re-derived `bucket`, no opening a posting URL to
   refresh a field.
4. Deliver in the shape `format-views.md` picks.
