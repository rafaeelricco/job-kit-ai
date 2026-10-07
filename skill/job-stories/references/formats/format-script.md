# Job pitch — vetting video script

One story per render. The English check runs 1–3 minutes and asks for the single
most significant technical challenge: situation, task, steps taken, outcome, lessons
— in that order. It scores English and communication and is never shown to an
employer, so this render optimizes for speech, not for a form field.

## Word budget

Spoken English runs about 130 words per minute. Print `{n} words · ~{s}s` under each
version.

| Version   | Words   | Spoken |
| --------- | ------- | ------ |
| Opener    | 30–40   | ~15s   |
| 30-second | 60–70   | ~30s   |
| 90-second | 180–200 | ~90s   |

Opener plus the 90-second version is the submission — about 105 seconds, inside the
window. Over budget → cut a beat whole. Never buy words by dropping the outcome or
the lesson; those are two of the five required parts.

## Shape

    ## Opener
    ## 30-second version
    ## 90-second version
    ## The beats, for follow-ups
    ### Situation
    ### Task
    ### Action
    ### Outcome
    ### Lessons
    ## Numbers I can say
    ## Do not say
    ## Delivery notes
    ### Gaps

`## Opener`, `## 30-second version`, and `## 90-second version` are blockquoted
speech — verbatim what goes in the mouth, no stage directions inside the quote.

`## Opener` carries domain title, computed years of experience, current company
from `data/experiences.yml`, and the `Core Stack` items from `data/skills.yaml`.
Nothing else; the read set holds no name, so the operator says it before the
Opener. A hobby, a pet, or a family fact here is the failure the recording is
screened for.

The five beats map to the deck: `Situation` and `Task` from `evidence.problem`,
`Action` from `evidence.decision` — which must name what was chosen **and what it
replaced** — `Outcome` from `evidence.impact` plus any eligible number, `Lessons`
from `volunteer` and the story's own concession. `evidence.difficulty` feeds the
follow-up beats, not the 90-second cut.

`## Numbers I can say` lists each eligible entry as `{value} — {verified}`. None →
one line saying the story has no outcome number and what would have to be measured
to get one.

`## Do not say` is every `never_say.claim` verbatim with its reason, plus one line
naming that process numbers were filtered — never the filtered numbers themselves.

`## Delivery notes` gives pause points and the one bait line worth leaving for a
follow-up question. It never tells the operator to memorize: a recited script is
what the check penalizes.
