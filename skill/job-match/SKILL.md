---
name: job-match
description: "Deep-rank scout dossiers, score one named dossier, or score one posting already in the conversation against MatchingPolicy. Returns a read-only fit report plus source-grounded resume guidance for displayed jobs. Not for searching (job-scout), printing scores as stored (job-list), or editing or generating a CV (job-resume-refine)."
argument-hint: "[<dossier> | --new | --all | --posting | --exclude <status>[,…] | --top <n> | --engine typesafe | <auto-detect>]"
---

# Job match

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve `scout/` and every `data/*` path against Profile root (not CWD, not skill dir).
Unreadable required file under a resolved root → stop and say so.

Write-set: none. Direct calls return chat only; worker and state JSON stay in-session
or in one run-scoped temp directory outside Profile root, removed after **report**.

Main is the orchestrator. Nodes, edges, and state live in the flow.

Skill-local files: `./references/**`, `./scripts/*.py`, and `./agents/*.md` only. Resolve both
against the directory containing this loaded `SKILL.md`, never the caller's CWD.

Read `./references/flows/flow-match.md` now.
Load each additional reference only when that flow names it.
