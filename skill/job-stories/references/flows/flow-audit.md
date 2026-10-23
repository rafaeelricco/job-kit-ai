# Audit

Read-only. Never writes, never repairs, never re-derives a story's content.

Glob `data/stories/*.md`, skipping `README.md` and any `_`-prefixed basename.
Print `Deck: {root}/data/stories/` first. Directory absent → say the profile has
no deck yet and point at `/job-profile` or `add`, then stop.

| Column   | From                                                                     |
| -------- | ------------------------------------------------------------------------ |
| story    | `id`                                                                     |
| status   | derived per `./references/schemas/schema-story.md`, not the stored value |
| covers   | `covers`, comma joined                                                   |
| blocking | the first thing keeping it off `ready`                                   |

Then `### Gaps`, one line each:

- a story whose stored `status` disagrees with the derived one
- an `impact_numbers` entry with `verified: unverified`
- a `company` matching no row in `data/experiences.yml`
- a file whose frontmatter will not parse — name it, never guess its fields

Rows plus Gaps must account for every globbed file. Unknown value → `—`, never
invented.
