---
name: job-profile
description: "Create, register, or edit a job-search profile. Use when the user runs /job-profile, /job-profile-init, or /job-profile-me, asks to scaffold a profile, show search config, change positions or packs, or what is missing for scout. Not for finding jobs (job-scout)."
argument-hint: "[show | gaps | cv | continue fill [<field>] | search set … | packs [list|enable|disable|formulations|location|add|remove] … | card refresh | cv set … | qa <add|answer|remove|ingest> …]"
---

# Job profile

Create or register a profile, or edit one that already exists.

When the operator asks to create / scaffold / register a profile, or no
Profile root resolves: if `$HOME` ends with `/.aside/runtime/home`, STOP —
profile setup requires a coding agent. Otherwise obey **Init** below. Do not
load `job-profile-root` on the create path.

When a Profile root already resolves and the operator is not creating: load
the `job-profile-root` skill now; obey it end-to-end; then **Edit**.

## Init (create / register)

Create a **new** data-only profile checkout. Refuse non-empty targets.
Materialize shells only from `./templates/`.
Outside `<target>`, write only Profile-root pointer files, and only via
**Activate** after operator **Yes**. Read-only until profile **Approve**.

1. Read `./references/flows/flow-intake.md`; run its named stages (**Route** →
   **Folder** → **Activate ask + Source** (one turn, create path) →
   **Identity** → **Profile questionnaire** → **Approve**). **Register
   existing** ends intake after a standalone **Activate ask**: skip
   Folder/Source/Identity/Profile questionnaire/Approve; go to step 4 with that
   path as `<target>`. Pointer pre-discovery runs before Route.
2. On Approve: obey `./references/flows/flow-emit-tree.md` end-to-end (write → tokens → leak gate).
3. After Approve, obey `./references/flows/flow-fill.md`. No post-approval field questions.
4. **Activate** Profile root for absolute `<target>`, branching on the Activate
   ask. Exactly one bullet runs, and it ends the skill.
   - **Yes** → obey `./references/flows/flow-activate.md` end-to-end.
   - **No**, and `<target>` equals `JOB_KIT_CONFIG` / host-default
     (path-convention probe without pointer) → this profile would
     auto-activate on emit despite the refusal: re-run the Activate ask instead.
   - **No**, otherwise → obey `./references/flows/flow-activate.md` for Activate-skipped handoff
     (next-steps only).

## Edit (existing profile)

Edit an existing profile.

Resolve every `data/*` path against Profile root (not CWD, not skill dir).
Do not read `scout/jobs/*.md`.
Skill-local files: `./references/**`, plus `./templates/data/answers.yaml` for
the legacy `candidate.yaml` move.

Mutate write-set: `data/job_search.yaml` (search keys, plus the fact keys the
legacy `candidate.yaml` move writes), `data/answers.yaml` (`qa[]`),
`data/profile_card.yaml`, `data/search_packs.yaml`, `data/cvs.yaml`, and their
`*.yaml.tmp` staging siblings during atomic rename; `data/candidate.yaml` is
deleted by that move only. Continuation fill writes the
`./references/flows/flow-fill.md` set instead.

When the operator runs `/job-profile` itself (not a skill loading this edit
path) and `data/candidate.yaml` exists, read `./references/flows/flow-mutate.md`
now and offer its legacy `candidate.yaml` move first; after that cycle ends,
continue with the route below.

When the operator asks to find jobs / scout openings, hand off `job-scout`, then
end this skill.
When the operator says `continue fill`, with or without naming a field, read
`./references/flows/flow-fill.md` now.
When the operator mutates search config, packs, the profile card, CV settings, or
reusable answers (`search set` / `packs` / `card refresh` / `cv set` / `qa`), or asks to change salary, notice,
visa, sponsorship, EOR, Fact fields, or identity, read `./references/flows/flow-mutate.md` now.
Otherwise read `./references/flows/flow-show.md` now.
Load each additional reference only when that flow names it.

## References

- Intake: `./references/flows/flow-intake.md`
- Emit tree: `./references/flows/flow-emit-tree.md`
- Fill: `./references/flows/flow-fill.md`
- Activate: `./references/flows/flow-activate.md`
- Show: `./references/flows/flow-show.md`
- Mutate: `./references/flows/flow-mutate.md`
- Next steps: `./references/formats/format-next-steps.md`
- Templates: `./templates/`
- Questionnaire: `./references/formats/format-questionnaire.md`
- Profile card: `./references/schemas/schema-profile-card.md`

## Hard refuses

- Invent salary, visa, sponsorship, EOR, relocation, employers, skills, or numbers
- Network scrape / session harvest of LinkedIn (user-handed export **file** is OK as SoT)
- Generate a CV PDF or LaTeX
- Run job-scout or job-apply
- Edit a non-empty or donor profile on the Init path
- Run an installer from under the profile tree. Kit install is the kit directory's
  `scripts/install.sh`.
