---
name: job-match
description: "Deep-rank scout dossiers, score one named dossier, or score one posting already in the conversation against MatchingPolicy. Returns a read-only fit report plus source-grounded resume guidance for displayed jobs."
argument-hint: "[all | <dossier>] [--exclude <status>[,…]] [--top <n>] [--typesafe]"
---

# Job match

Main is the orchestrator.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve `scout/` and every `data/*` path against Profile root (not CWD, not skill dir).
`data/candidate.yaml` present → stop; migrate via `/job-profile`.

Skill-local files: `./references/**` and `./scripts/*.py` only. Resolve them
against the directory containing this loaded `SKILL.md`, never the caller's CWD.

Read `./references/flows/flow-match.md` now.
Load each additional reference only when that flow names it.
