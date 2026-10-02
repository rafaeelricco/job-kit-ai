# stories/

One markdown file per interview story. `/job-profile` creates empty stubs from
the names you gave it; `/job-stories add` fills one from evidence, and
`/job-stories audit` reports what is still missing.

Frontmatter keys: id, company, covers, claim, evidence, impact_numbers,
never_say, volunteer, sources, status.

`job-apply`, `job-outreach`, `job-stories`, and `job-resume-refine` read **frontmatter only**.
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
