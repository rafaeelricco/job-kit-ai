# Job match - list route

The `/job-match` entry has already resolved Profile root and loaded job-store.
Use the resolved root for all paths below.

1. Print `Store: {root}/scout/jobs/` before answering. If `scout/` or
   `scout/jobs/` is absent, say no dossiers have persisted yet and stop; creating
   them is job-scout persist. If present but unreadable, stop and name the path.
2. Read `./references/formats/format-views.md` and glob `scout/jobs/`.
3. Print `score`, `bucket`, and posting facts as they sit on disk. This route is
   read-only: do not calculate a score, re-derive `bucket`, or open a posting URL
   to refresh a field.
4. Deliver in the shape `format-views.md` picks.
