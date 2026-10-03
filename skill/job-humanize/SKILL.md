---
name: job-humanize
description: "Rewrite pass named by job-* skills after a draft. Not user-invoked."
---

# Job humanize

Make already-drafted outbound job prose sound like a person wrote it, not a
script or a chatbot. Not a letter, resume, or script writer.

Open nothing outside this skill: no Profile root file, no URL. The brief is
the whole evidence set.

Skill-local: `./scripts/detect.py` only. Resolve it against the directory
containing this loaded `SKILL.md`, never the caller's CWD.

## Brief

The caller pastes `Surface`, `CONTRACT`, and `DRAFT`. If one is missing, stop
and name the hole. Return only the rewritten `DRAFT`: no note, no pattern list,
no commentary, never a Fact path or a caller flow file.

`CONTRACT` is absolute; this file comes second. Do not merge or split CONTRACT
slots. Rewrite only the surface's `In` column; a skill token, heading, tech-tag
line, or sentence the CONTRACT marks verbatim stays as written.

| Surface    | Register | In                                 | Out                                                           |
| ---------- | -------- | ---------------------------------- | ------------------------------------------------------------- |
| summary    | written  | Summary sentences 1 and 3          | sentence 2, bullets, Skills tokens, rest of `.tex`            |
| resume     | written  | reworded resume bullets            | the Summary block, Skills tokens, headings, role fields       |
| script     | spoken   | Opener and timed speech blocks     | `Do not say`, Gaps, numbers list, headings                    |
| experience | written  | S.T.A.R.T. bullets                 | `position`, tech tags, Gaps, each bullet's `**Label** —` lead |
| letter     | written  | letter prose and free-text answers | the question text, lines the CONTRACT marks verbatim          |

Unknown surface → stop and name `summary|resume|script|experience|letter`.

## Facts

Keep every claim in the draft and add none. A name, number, date, quote,
source, outcome, or scope counts as a fact; take it only from the brief.
Shorten, expand, merge, or split inside a slot, never across slots. A `we`
claim stays `we`.

This is factual outbound text: stay neutral. No opinion, humor, or first
person the CONTRACT forbids. The rewrite stays in the draft's language.

Leave code, YAML, structured data, link targets, quotations, titles, and names
as they are.

## Defaults

Spoken: one idea per sentence; light connectors (`so`, `and`) when they help;
no fake hesitation. Keep any word budget or speaking time the brief gives.

Written: the same plainness without imitating speech.

`letter` and `script`: split any sentence over about 25 words, keeping the
order of ideas, unless the CONTRACT fixes that slot's sentence count.
`summary`, `resume`, and `experience` keep their sentence shape.

Keep what already sounds natural, and keep human detail: odd specifics and
uneven sentence length. Don't add roughness to seem human: forced fragments, a
short-long seesaw, or planted slips read as machine-made too.

## Tells to remove

These make text read as machine-written. Remove them from the output. Three or
more in one paragraph mean the paragraph was generated: rewrite it from its
facts instead of swapping words.

`scripts/detect.py` matches every quoted phrase below in English text; a single
word also matches its longer forms (leverage, leveraging), and X, Y, Z, and …
stand for any words. After editing this list, run the kit's unit stage
(`bash scripts/test.sh --only unit`): its `test_detect.py` checks that each
phrase is caught.

- Stacked self-labels (passionate, results-driven expert). Give the example instead.
- Inflated significance: "stands as", "serves as", "testament", "pivotal", "key role", "landscape", "underscore", "marks a shift".
- Sales and stock words: "vibrant", "seamless", "stunning", "leverage", "boast", "groundbreaking", "nestled", "game-changer", "delve", "tapestry", "realm", "intricate", "utilize", "foster", "streamline", "showcase", "garner", "bolster", "meticulous", "deep dive", "move the needle".
- An -ing tail that only inflates: ", highlighting X", ", underscoring X", ", showcasing X", ", emphasizing X".
- "Not X, but Y", "It's not just X, it's Y", "Stop X, start Y", and objections nobody raised: "To be clear", "This isn't about".
- Lists padded to three, or one idea under three synonyms.
- Announcing or dramatizing: "Let's dive in", "Here's the thing", "Here's what", "Here's why", "Here's how", "Honestly?", "Let me be honest", "Real talk", "Unpopular opinion", "The real question is", "The result?", "The catch?", "No X. No Y. Just Z.", "Let that sink in", a row of one-line punchlines.
- Stock openers and closers: "I'm excited to announce", "I'm excited to share", "thrilled to share", "In today's fast-paced world", "In conclusion", "In summary", "To summarize", "Looking ahead", "Thoughts?", "Agree or disagree?", "Let me know in the comments", "Tag someone".
- Chatbot wrappers inside the artifact: "Certainly!", "You're absolutely right", "Great question", "I hope this helps", "Want me to…?", an upbeat send-off.
- Filler and hedges on known facts: "It is important to note", "It's worth noting", "in order to", "could potentially".
- Em and en dashes.
- Decorative bold, bold-label bullet lists, Title Case headings, emoji on headings.
- Vague sources ("experts say", "studies show") and guesses dressed as facts ("while details are limited").
- Generation leftovers: "oaicite", "contentReference", "turn0search", "[Your Name]", "As of my last update", "As of my knowledge cutoff".

Tells adapted from Wikipedia's "Signs of AI writing" via blader/humanizer, with
additions from sergebulaev/linkedin-skills.

## Before returning

Write the rewrite to a UTF-8 file in the system temp directory with your
file-writing tool. Put one slot per paragraph, with a blank line between bullets
or answers. Pass its path to `./scripts/detect.py`, then delete the file. Don't
pipe or redirect it through a shell: Windows PowerShell turns dashes and curly
quotes into `?`. Use the first working Python 3 launcher: `python3`; on
Windows, `py -3`; otherwise `python` only when its major version is 3. Add
`--max-words 0` for `summary`, `resume`, and `experience`.
Missing launcher or script → stop and name it. Fix each hit; a hit inside a
name, quotation, technical term, or text the Surface or CONTRACT keeps as
written stays. Then reread it once: every claim in the draft is present,
nothing new was added, no tell remains, and the CONTRACT holds.
