# Profile work experience

One block per company in `data/experiences.yml`, newest first, unless the operator
names one. This is a profile field, not speech: bullets, quantitative where the deck
allows it, stacks kept out of the prose because the platform has a separate tags
field for them.

## Shape

    ### {company} — {position}
    {date} · {location}

    - **Situation** — company and project context, with size numbers where a file prints them
    - **Task** — the goal of the work
    - **Action** — what the operator did
    - **Result** — impact, quantitative where an eligible number exists
    - **Take away** — one to three things learned

    Tech tags: `a`, `b`, `c`

    ### Gaps

## Field law

`Situation` and `Task` come from `evidence.problem` of the company's stories, falling
back to `summary[]` bullets when the company has no story.

`Action` is the operator's own contribution. Team work described as "we" in the
source stays attributed to the team or is dropped — it is never rewritten into a
personal claim to fill the bullet.

`Result` carries an eligible outcome number when one exists. When none does, state
the qualitative outcome and add a `### Gaps` line naming the number that is missing.
"It worked", "the client was happy", and "shipped to production" are not results.

`Tech tags` are drawn from `data/skills.yaml` items that the company's stories and
`summary[]` bullets actually evidence. Never from the whole skills file. Stacks named
here never also appear in the five bullets.

## Title law

Print `position` verbatim. When it reads as a discouraged title — Analyst, Programmer,
Web Dev, or a language-named role such as "JavaScript Developer" — add a `### Gaps`
line proposing the domain equivalent (Front-End Engineer, Full-Stack Engineer,
Back-End Engineer, Tech Lead, Product Designer). Never silently re-title a role the
profile names differently; the file is Fact and this skill does not write.

A `position` that encodes a promotion path rather than a title renders verbatim, with
the sub-role windows kept in `Take away` if they carry the point.

## A company with no story

Render `Situation`, `Task`, and `Action` from `summary[]` only, print no `Result`, and
add a `### Gaps` line naming that the company has no story backing. Never synthesize
an outcome to complete the shape.
