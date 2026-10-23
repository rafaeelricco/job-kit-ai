---
name: job-profile
description: "Create, register, or edit a job-search profile. Use when the user runs /job-profile, /job-profile-init, or /job-profile-me, asks to scaffold a profile, show search config, change positions or packs, or what is missing for scout."
argument-hint: "[show | gaps | cv | continue fill [<field>] | search set … | packs [list|enable|disable|formulations|location|add|remove] … | card refresh | cv set … | qa <add|answer|remove|ingest> …]"
---

# Job profile

Create or register a profile, or edit one that already exists.

**Init** (create / register): when the operator asks to create / scaffold /
register a profile, or no Profile root resolves: if `$HOME` ends with
`/.aside/runtime/home`, STOP — profile setup requires a coding agent.
Otherwise read `./references/flows/flow-intake.md` now and obey it
end-to-end. Do not load `job-profile-root` on the create path.

When a Profile root already resolves and the operator is not creating: load
the `job-profile-root` skill now; obey it end-to-end; then **Edit**.

## Edit (existing profile)

Resolve every `data/*` path against Profile root (not CWD, not skill dir).
Do not read `scout/jobs/*.md`.
Skill-local files: `./references/**`, `./scripts/geography.py` and its bundled
`./scripts/geography.json`, plus `./templates/data/answers.yaml` for the legacy
`candidate.yaml` move.

When the operator runs `/job-profile` itself (not a skill loading this edit
path) and `data/candidate.yaml` exists, read `./references/flows/flow-mutate.md`
now and offer its legacy `candidate.yaml` move first; after that cycle ends,
continue with the route below.

When the operator runs `/job-profile` itself for ordinary display or explicitly
requests the deprecated hiring-region migration, and `data/job_search.yaml` has
such a field, read `./references/flows/flow-mutate.md` and offer its
residence-dependent migration before display. If residence is absent or
unresolved, stop and direct them to `/job-profile continue fill basics.country`;
that continue-fill request always routes to `flow-fill.md` without repeating
this migration offer. After the migration confirm cycle ends, continue with the
route below. Read-only skills that load `flow-show.md` do not enter this
mutation path.

When the operator asks to find jobs / scout openings, hand off `job-scout`, then
end this skill.
When the operator asks to discover companies or find employer boards, hand off
`job-company-scout`, then end this skill without doing research here.
When the operator says `continue fill`, with or without naming a field, read
`./references/flows/flow-fill.md` now.
When the operator mutates search config, packs, the profile card, CV settings, or
reusable answers (`search set` / `packs` / `card refresh` / `cv set` / `qa`), or asks to change salary, notice,
visa, sponsorship, EOR, Fact fields, or identity, read `./references/flows/flow-mutate.md` now.
Otherwise read `./references/flows/flow-show.md` now.
Load each additional reference only when that flow names it.

## Hard refuses

- Invent salary, visa, sponsorship, EOR, relocation, employers, skills, or numbers
- Network scrape / session harvest of LinkedIn (user-handed export **file** is OK as SoT)
- Generate a CV PDF or LaTeX
- Run job-scout or job-apply
- Edit a non-empty or donor profile on the Init path
- Run an installer from under the profile tree. Kit install is the kit directory's
  `scripts/install.sh`.
