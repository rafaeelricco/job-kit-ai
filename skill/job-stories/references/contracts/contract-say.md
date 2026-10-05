# Job pitch — what may be said

Both verbs read the same files and obey the same say law. Load this before either
format.

## Read set (all under Profile root)

| Path                   | What it supplies                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `data/stories/*.md`    | frontmatter only: `claim`, `evidence.*`, `impact_numbers`, `never_say`, `volunteer`, `status` |
| `data/experiences.yml` | `company`, `position`, `location`, `date`, `summary[]`                                        |
| `data/skills.yaml`     | `skills[].category` + `.items[]` — the tech-tag source                                        |

`README.md` and any `_`-prefixed basename under `data/stories/` are not stories.
Story bodies are rehearsal text written for a different room; read frontmatter only.
`data/basics.yaml`, `data/job_search.yaml`, and `data/answers.yaml` are not in
the read set — see the personal-information refuse.

## The number firewall

An `impact_numbers` entry may be spoken only when `kind: outcome` **and** `verified`
is not `unverified`.

- `kind: process` never reaches rendered text. Not as a digit, not in words. "Dozens
  of PRs" is the same banned number spelled differently.
- No eligible entry → say the story carries no shippable number and render without
  one. Never substitute a process number, never estimate, never turn a date range
  into an achievement.
- Years of experience is the only number this skill derives: run the installed
  `job-match/scripts/years.py` (launcher per
  `job-match/references/flows/flow-match.md` **score**) on every role's `date`
  in `data/experiences.yml`. `years: null` → say the number is unavailable,
  never 0.

## The credit rule

Strider asks for what the operator did, not what the team did — and the deck already
records where that line falls.

- Render first person singular only where the story's own text is singular. A
  sentence that says "we" stays "we". Never promote it.
- Every `never_say` entry is a filter on the drafted text, checked before printing,
  not a footnote after it.
- `volunteer` entries are the weaknesses to state before being asked; the `script`
  verb places them, the `experience` verb drops them.

## Status gate

- `ready` → render.
- `needs-numbers` → render, and name the missing outcome number in `### Gaps`. The
  render says so out loud rather than filling the hole.
- `draft` → refuse. An `evidence` part is empty; point at `add` and STOP.

## Coverage

Rendered output plus `### Gaps` must account for every story or company asked about.
Unknown = `—`, never invented. A story the operator did not ask about is never named.
