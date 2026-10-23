---
name: job-store
description: "Internal dossier law for job-* skills. Not user-invoked."
---

# Job store

Load-path only: the caller already resolved Profile root and owns the verb, any
glob, and the view. This skill runs none of them and does not print `Profile root:` or `Store:`.

Skill-local files: `./references/**` and `./scripts/*.py` only. Resolve both
against the directory containing this loaded `SKILL.md`, never the caller's CWD.

Read now, in order:

1. `./references/schemas/schema-dossier.md`
2. `./references/contracts/contract-persistence.md`
3. `./references/flows/flow-read.md`

Obey all three end-to-end. Load no other file from this skill unless a caller names it.
