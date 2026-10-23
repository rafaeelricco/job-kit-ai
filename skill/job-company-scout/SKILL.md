---
name: job-company-scout
description: "Discover and maintain relevant companies and their official career boards in search_packs.yaml. Use when the operator explicitly runs /job-company-scout or asks to discover companies or boards."
argument-hint: "[status | all | <market-id> ...] [--batch-size N] [--refresh]"
---

# Job company scout

Discover companies from configured market sources and maintain their verified
company and careers-board records in `data/search_packs.yaml`.

Profile root: load the `job-profile-root` skill now; obey it end-to-end. A
`job-profile-root` stop means no profile, so stop here; never scaffold one.

On explicit `/job-company-scout` invocation or a direct request to discover
companies or boards, read `job-profile/references/flows/flow-show.md` for the
read set and card and constraints derivation. Read
`job-profile/references/schemas/schema-search-packs.md` and
`./references/flows/flow-discover.md`, then follow the discovery flow. Never
route through `job-profile/SKILL.md` or enter its mutation flow. Resolve
`data/*` against Profile root.

This explicit request authorizes web research, discovery history, and changes
to discovery-owned inputs. This skill writes `data/search_packs.yaml`,
its per-publication `data/search_packs.yaml.{run token}.tmp` stage, and
operational state under `scout/runtime/company-scout/`. The batch flow and
helper contracts are defined in `./references/flows/flow-discover.md`.
Listing markets and `status` are read-only. It does not run
`/job-scout` or `/job-apply`, contact
companies, send messages, or schedule future work.
