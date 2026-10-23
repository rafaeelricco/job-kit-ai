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
Resolve `data/*` against Profile root.

Skill-local files: `./references/*` and `./scripts/*` only.
Read `./references/flows/flow-discover.md` now.
Load each additional reference only when that flow names it.
