# Prose contract

Rules for every composed free-text value job-apply authors: a cover letter, an
outbound message, and a question field that wants sentences. Paste this file
verbatim as `CONTRACT` when loading `job-humanize` with `Surface: letter`.

## Sources

`data/stories/*.md` frontmatter only (`claim`, `evidence.*`, `impact_numbers`,
`never_say`, `covers`, `status`), `data/experiences.yml`, `data/skills.yaml`,
`data/education.yaml`, and the live ad. Story bodies stay closed.
`data/basics.yaml` and `data/candidate.yaml` feed slot 6 only. Every sentence
traces to one source or to the ad; a sentence that traces to nothing is cut.
A `draft` story is never a source.

## Letter shape

Fixed order. Unfired slots are absent, not empty.

| Slot        | Fires       | Content                                                                                  |
| ----------- | ----------- | ---------------------------------------------------------------------------------------- |
| 1 Authority | always      | The system built that the ad describes; never a title or years                           |
| 2 Piercing  | always      | The problem behind a direct requirement, sharpened only from the ad                      |
| 3 Method    | conditional | The decision inside the carrying story and what it replaced                              |
| 4 Proof     | conditional | The resulting outcome, not an activity                                                   |
| 5 Bridge    | conditional | One supporting fact, stated briefly, answering a requirement the carrying story does not |
| 6 Terms     | conditional | Geo, authorization, or engagement position, with the decision handed back                |
| 7 Ask       | always      | One sentence proposing the conversation                                                  |

The carrying story is the `ready` or `needs-numbers` story whose `covers`
overlaps the ad most; the letter rests on it, not on a list of supporting
facts. Slot 6 fires only when geo, authorization, or engagement is unmet. A
skill gap belongs in slot 2 or 3.
No such story → slots 3 and 4 do not fire; slots 1, 2, 5, and 7 draw on
`data/experiences.yml`, `data/skills.yaml`, and the ad, and slot 5 may carry
the role that overlaps the ad most. A letter never states a method or an
outcome the deck does not hold.

## Short answers

A question field (`Why us?`, `What did you study?`, `Describe a project`) gets
an answer to that question only, as short as a recruiter skimming the form
needs, from the same sources.
A part the files do not print is named as not on record in plain words
(`I do not have a grade figure to share`), never estimated. A word or
character limit the field prints is a hard limit.

## Voice law

### Open

- First sentence states the fit. Never open on interest, enthusiasm, or the act of writing. `I am writing to express my interest` is the failure.

### Address

- Slots 1 and 2 open on the reader, not on `I`.

### Method and proof

- Slot 3 names what was chosen and what it replaced. A sentence that only names what was built is not a method.
- Slot 4 is the resulting outcome. `It worked`, `the client was happy`, and `shipped to production` are not proof.
- Prefer the verb a human would say over a resume compound noun.

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

### Close

- Slot 6 states the position, hands the decision back, and stops.
- Slot 7 is an ask, never a thank-you. `I look forward to hearing from you` is the failure.

## Forbidden claims

Every `never_say` entry in `data/stories/*.md` frontmatter, exact or
semantically equivalent, in the letter, the subject line, and every authored
value.
