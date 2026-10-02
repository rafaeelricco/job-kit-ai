---
name: job-resume-refine
description: "Tailor a one-page resume to one posting — obtain fresh read-only job-match guidance, resolve it against full profile Facts, humanize allowed prose, compile a PDF, and report what changed. Use when the user runs /job-resume-refine or asks for a tailored resume or CV PDF for a posting. Not for preparing the whole application package (job-apply), ranking openings (job-scout), or editing Fact YAML (job-profile)."
argument-hint: "<dossier> | <url> | <pasted ad>"
---

# Job resume refine

Tailors one page to one posting from Facts already on disk. It never invents
a role, a number, or a skill the profile does not have.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve `data/`, `cv/`, and `scout/` against that root.

Writes `scout/applications/{slug}/` only. `data/` and `cv/` stay read-only.

Skill-local files: `./references/**` and `./scripts/*.py` only. Resolve both
against the directory containing this loaded `SKILL.md`, never the caller's CWD.

Read `./references/flows/flow-refine.md` now.
Load each additional reference only when that flow names it.

## References

- `./references/flows/flow-refine.md`
- `./references/contracts/contract-refine.md`
- `./references/formats/format-summary.md`
- `./references/formats/format-report.md`

## Hard refuses

- Invent an employer, title, date, number, or skill with no Fact home
- Write any path under `data/`, `cv/`, or `scout/jobs/`
- Print salary, sponsorship, visa, notice, route, or a process count
- Author or convert a base source, or change preamble, margins, or font size
