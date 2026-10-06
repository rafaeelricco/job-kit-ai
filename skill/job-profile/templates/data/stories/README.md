# stories/

One markdown file per interview story. `/job-profile` creates empty stubs from
the names you gave it; `/job-stories add` fills one from evidence, and
`/job-stories audit` reports what is still missing.

Frontmatter keys: id, company, covers, claim, evidence, impact_numbers,
never_say, volunteer, sources, status.

`job-apply`, `job-stories`, and `job-resume-refine` read **frontmatter only**.
The body below it is rehearsal and never reaches outbound text.

How a story is read, and why:

[claim + evidence + shippable numbers] − [never_say]

id Slug; equals the basename without `.md`.
company Must match a `company` in `data/experiences.yml`, or `""`
for a side project.
covers Question tags; free list, lowercase kebab.
claim One sentence, conclusion first. Never a title.
evidence `problem`, `decision`, `difficulty`, `impact` — all four,
prose, no bullets. `decision` states what was chosen and
what it replaced.
impact_numbers `{value, verified, kind}`. `kind: outcome` may ship;
`kind: process` (PRs, LOC, commits) may be stored and
never reaches outbound text.
never_say Banned outbound claims, each with the reason it is false.
volunteer Weaknesses to state before being asked.
sources Where each field was checked.
status Derived: `draft` | `needs-numbers` | `ready`. Never asserted.

Rules: `README.md` and any file whose name starts with `_` are not stories.
Status is derived from evidence and numbers, never set by hand. Each skill
that drafts outbound text checks `never_say` from the file, not from memory.

## Writing bullets

For `summary[]` in experiences.yml and `description[]` in projects.yml.
Action → how → outcome. Add ownership or pace only when it adds evidence.

- Lead with the strongest fact and an accurate verb.
- Explain the mechanism or decision when it clarifies the work.
- Show an observed result. Use numbers only when they're supported.
- Make your own part clear, separate from the team's.
- One claim per bullet, past tense, no code names.
- Never invent metrics, adoption, ownership, or outcomes.
