---
name: job-scout
description: "Find and rank live job openings from operator-selected search packs or ad-hoc site URLs, report results, and persist scout dossiers. List-only. Use when the user runs /job-scout or asks to find, search, or scout openings."
argument-hint: "[all | <pack-id>…] [<url>…] | refresh [--typesafe]"
---

# Job scout

Find, rank, and persist live openings from search packs or ad-hoc site URLs.

Profile: load `job-profile`'s edit path; a `job-profile-root` stop means no
profile, so stop here. It owns the read set and card derivation
(`job-profile/references/flows/flow-show.md`,
`job-profile/references/schemas/schema-profile-card.md`). Never enter its
mutation flow. Resolve `data/*` against Profile root.

Store law: load the `job-store` skill now; obey it end-to-end.

Skill-local files: `./references/**` only.
Read `./references/flows/flow-scout.md` now.
Load each additional reference only when that flow names it.
