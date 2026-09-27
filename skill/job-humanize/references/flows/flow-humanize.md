# Humanize pass

Caller pastes `Surface`, `CONTRACT`, and `DRAFT`. Return only the rewritten
`DRAFT`: no pattern list, no commentary. Never a Fact path, never a caller
flow file.

If `Surface`, `CONTRACT`, or `DRAFT` is missing, stop and name the hole.

## Precedence

1. `CONTRACT` in the brief is absolute.
2. This file.

Do not merge or split CONTRACT slots. Rewrite only the surface's `In` column
below; a skill token, heading, tech-tag line, or sentence the CONTRACT marks
verbatim stays as written.

## Surfaces

| Surface    | In                                 | Out                                                     |
| ---------- | ---------------------------------- | ------------------------------------------------------- |
| summary    | Summary sentences 1 and 3          | sentence 2, bullets, Skills tokens, rest of `.tex`      |
| resume     | reworded resume bullets            | the Summary block, Skills tokens, headings, role fields |
| script     | Opener and timed speech blocks     | `Do not say`, Gaps, numbers list, headings              |
| experience | S.T.A.R.T. bullets                 | `position`, tech tags, Gaps                             |
| letter     | letter prose and free-text answers | the question text, lines the CONTRACT marks verbatim    |

Unknown surface → stop and name `summary|resume|script|experience|letter`.

## Deltas

- Keep every claim. Shorten, expand, merge, or split inside a slot, never across slots.
- No new fact, name, number, date, quote, or citation.
- Factual outbound: stay neutral. No opinions, humor, or first person the CONTRACT forbids.
- A `we` row stays `we`.

## Tells

The target register is a person describing their own work plainly, in the
words they would use out loud. Tells that recur in drafted resume and pitch
prose: inflated importance or legacy; sales `-ing` tack-ons; `serves as` /
`stands as` / `boasts`; sales adjectives; signposting (`let's dive in`);
forced groups of three; synonym cycling.

Do not restate em dash, hedge, confidence theater, process numbers, or `never_say`. Those live in the pasted CONTRACT.

Rewrite a flagged passage around its claim, not word by word.
