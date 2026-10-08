---
name: job-stories
description: "Write the interview story deck, or render it as a vetting script or S.T.A.R.T. bullets. Use when the user runs /job-stories or /job-pitch, asks to add a story, which stories need numbers, a 90-second script, or work-experience bullets."
argument-hint: "[add | audit | script | experience]"
---

# Job stories

Fill Profile root `data/stories/` from evidence, or render that deck as outbound
narrative. Profile creation is `job-profile` (empty stubs). Every write is
diff → confirm → write. Renders write nothing.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Resolve every `data/*` path against Profile root (not CWD, not skill dir).
Unreadable required file under a resolved root → stop and say so.
Writable here: `data/stories/*.md` and their `*.md.tmp` staging siblings during
atomic rename. Every other path under Profile root is read-only in this skill.

1. Read `./references/schemas/schema-story.md` now; field law for `add` and `audit`.
2. `add`: obey `./references/flows/flow-author.md` end-to-end.
3. `audit`: obey `./references/flows/flow-audit.md`. Read-only; never repairs.
4. `script` / `experience`: read `./references/contracts/contract-say.md` now; it is
   the read set and the say law for both verbs. `script` renders per
   `./references/formats/format-script.md`. `experience` renders per
   `./references/formats/format-experience.md`. Nothing is written to disk —
   every render is printed for the operator to paste or to speak.
5. After a render, load the `job-humanize` skill and obey it end-to-end on the
   composed blocks (`script`: Opener and timed speech; `experience`: S.T.A.R.T.
   bullets). Brief: `Surface: script` or `experience`; `CONTRACT` is verbatim
   `contract-say.md`, and for `script` also the Word budget from
   `format-script.md`; those blocks as `DRAFT`. Replace them with the returned
   text. If the skill does not resolve, stop and name it. For `script`, recount
   `{n} words · ~{s}s` and cut to range. Then apply the `never_say` filter in
   `contract-say.md` and print.
6. No verb intent → run `audit`. If the operator asked for a script or
   experience write-up, list the `ready` stories with what each covers instead.

## Commands

| Utterance                                                    | Do                                          | Writes                   |
| ------------------------------------------------------------ | ------------------------------------------- | ------------------------ |
| write a story about X / turn Widget into an interview answer | `add`                                       | `data/stories/<slug>.md` |
| which stories need numbers / check my deck                   | `audit`                                     | —                        |
| vetting video script / how do I tell this one in 90 seconds  | `script`                                    | —                        |
| write my work experience / S.T.A.R.T. bullets for Acme Corp  | `experience`                                | —                        |
| create a profile / set one up from my CV                     | hand off `job-profile`, then end this skill | —                        |
| apply to this posting / get an application ready             | hand off `job-apply`, then end this skill   | —                        |

## References

- Story shape: `./references/schemas/schema-story.md`
- Authoring: `./references/flows/flow-author.md`
- Audit: `./references/flows/flow-audit.md`
- Say law: `./references/contracts/contract-say.md`
- Video script: `./references/formats/format-script.md`
- Work experience: `./references/formats/format-experience.md`

## Hard refuses

- Invent an outcome, a metric, a client name, an employer, or a date
- Write into `evidence.*` anything no entry in `sources` prints
- Write anything before printing the diff and receiving an explicit yes
- Speak an `impact_numbers` entry that is `kind: process` or `verified: unverified`, in digits or in words
- Speak anything a story's `never_say` bans
- Promote a story's "we" to "I", or render a credit the deck gives to someone else
- Render a hobby, family, marital status, age, health, religion, address, salary, or visa status
- List stacks inside the work-experience prose instead of the tech-tag line
- Network: no company research, no scrape, no sign-up
- Write any path outside `data/stories/`
- Run job-scout or job-apply
- Copy another profile's stories
