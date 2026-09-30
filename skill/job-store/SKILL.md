---
name: job-store
description: "Internal dossier law for job-* skills. Not user-invoked."
---

# Job store

Load-path only. Takes no token: no verb, no Profile-root probe, no glob, no view.

Caller already resolved Profile root. This skill does not print `Profile root:` or `Store:`.

Skill-local files: `./references/**` and `./scripts/*.py` only. Resolve both
against the directory containing this loaded `SKILL.md`, never the caller's CWD.

Read now, in order:

1. `./references/schemas/schema-dossier.md`
2. `./references/contracts/contract-persistence.md`
3. `./references/flows/flow-read.md`

Obey all three end-to-end. Load no other file from this skill unless a caller names it.

`./references/contracts/contract-tokens.md` is the token law for a caller that
parses a message. It is not part of this load path: only a skill that takes
arguments reads it, and it reads it by name.
