# Stories

Read `./references/schemas/schema-story.md` now; field law for `add` and `audit`.

Writable: `data/stories/*.md` and their `*.md.tmp` staging siblings during atomic
rename, only through `add`'s diff → explicit yes → write. Every other path under
Profile root is read-only in this skill. Renders write nothing; every render is
printed for the operator to paste or to speak.

## Route

| Utterance                                                    | Do                                          | Writes                   |
| ------------------------------------------------------------ | ------------------------------------------- | ------------------------ |
| write a story about X / turn Widget into an interview answer | `add`                                       | `data/stories/<slug>.md` |
| which stories need numbers / check my deck                   | `audit`                                     | —                        |
| vetting video script / how do I tell this one in 90 seconds  | `script`                                    | —                        |
| write my work experience / S.T.A.R.T. bullets for Acme Corp  | `experience`                                | —                        |
| create a profile / set one up from my CV                     | hand off `job-profile`, then end this skill | —                        |
| apply to this posting / get an application ready             | hand off `job-apply`, then end this skill   | —                        |

No verb intent → run `audit`. If the operator asked for a script or experience
write-up, list the `ready` stories with what each covers instead.

- `add`: obey `./references/flows/flow-author.md` end-to-end.
- `audit`: obey `./references/flows/flow-audit.md`.

## script / experience

1. Read `./references/contracts/contract-say.md` now: the read set and say law
   for both verbs.
2. `script` renders per `./references/formats/format-script.md`; `experience`
   renders per `./references/formats/format-experience.md`.
3. Load the `job-humanize` skill and obey it end-to-end on the composed blocks
   (`script`: Opener and timed speech; `experience`: S.T.A.R.T. bullets). Brief:
   `Surface: script` or `experience`; `CONTRACT` is verbatim `contract-say.md`,
   and for `script` also the Word budget from `format-script.md`; those blocks as
   `DRAFT`. Replace them with the returned text. If the skill does not resolve,
   stop and name it.
4. For `script`, recount `{n} words · ~{s}s` and cut to range.
5. Apply the `never_say` filter in `contract-say.md` and print.

## Hard refuses

- Invent an outcome, a metric, a client name, an employer, or a date
- Promote a story's "we" to "I", or render a credit the deck gives to someone else
- Render a hobby, family, marital status, age, health, religion, address, salary, or visa status
- Network: no company research, no scrape, no sign-up
- Run job-scout or job-apply
- Copy another profile's stories
