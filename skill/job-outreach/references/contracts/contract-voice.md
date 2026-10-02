# Voice contract

The rules of job-apply's prose contract that every outreach note obeys, copied
here word for word so this skill works on installs without job-apply. Change
both files together: `tests/test_invariants.py` fails when the sections differ.

## Sources

`data/stories/*.md` frontmatter only (`claim`, `evidence.*`, `impact_numbers`,
`never_say`, `covers`, `status`), `data/experiences.yml`, `data/skills.yaml`,
`data/education.yaml`, and the live ad. Story bodies stay closed.
`data/basics.yaml` and `data/candidate.yaml` feed slot 6 only. Every sentence
traces to one source or to the ad; a sentence that traces to nothing is cut.
A `draft` story is never a source.

## Voice law

### Number firewall

- Ship a number only when a story's frontmatter prints it as `kind: outcome` with `verified` not `unverified`.
- A process number counts activity (PRs, LOC, commits, review comments). It never ships, as a digit or in words.
- No such number → qualitative outcome only. Never estimate, never turn a date range into an achievement.

### Credit

- Keep the source's person. A claim that says `we` stays `we`. Never promote it to `I`.
- Never invent facts about the team, codebase, or hiring reason. Slot 2 may sharpen only a requirement printed in the ad.

### Surface

- No em dash in sent text. Use a comma, colon, or full stop.
- No hedge (`maybe`, `I think`, `I believe I could`) and no confidence theater (`I am confident that`).
- Cut exact dates, internal praise, and titles of people who noticed.

## Forbidden claims

Every `never_say` entry in `data/stories/*.md` frontmatter, exact or
semantically equivalent, in the letter, the subject line, and every authored
value.
