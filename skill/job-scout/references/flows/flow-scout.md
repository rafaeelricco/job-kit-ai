# Job scout — run

List only. Never apply, message, or connect.
Write-set: `scout/jobs/*.md` + lock furniture per job-store `contract-persistence.md`,
plus job-match's run-scoped temp directory outside Profile root during the match gate,
removed before this run ends.

Read each in order; obey it end-to-end:

1. `./references/flows/flow-preflight.md`
2. `./references/flows/flow-search.md`, including merge. Skip under `refresh`.
3. `./references/flows/flow-extract.md`, including its row validation.
4. `./references/flows/flow-gate.md`
5. `./references/flows/flow-rank.md`, which takes its persist set from `./references/flows/flow-match-gate.md`.
6. Persist, below.

## Persist

Write the persist set per job-store schema + persistence. One dossier per
persist-set row. After the write, if another readable dossier has a different
normalized `url` and the same `company` and `title` slug (schema-dossier
"Filename"), and neither file already has
`- {date} · equivalent of scout/jobs/{other} — job-scout` for that pair, append
that line on this file and on the other. Do not merge. Do not change `url`.
No dossier for kit drop or uncertain. Existing dead dossier → closure log only.

Under `refresh` every row already owns a dossier: a row that leaves the persist
set keeps its body and `status:` untouched beyond the schema's re-run rules for
dead and `incompatible`, but every re-extracted row that is not `dead` still
bumps `last_seen` so the next sweep moves past it, and Gaps names it.
