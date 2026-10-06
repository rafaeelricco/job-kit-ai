# CV quality rubric — version 2

These weights are a designed evaluation framework, not a scientifically
validated scale, employer ATS score, or prediction of interview success.
`./scripts/review_score.py` owns the arithmetic; keep its weights and cap
equal to this file.

| Criterion            | Weight | Assess                                                                |
| -------------------- | -----: | --------------------------------------------------------------------- |
| Positioning          |     15 | Top third of page 1: target title, specialty, strongest proof         |
| Achievement bullets  |     30 | Contribution, context, ownership, scope/outcome, clarity              |
| Skills and relevance |     15 | Focused capabilities that roles or projects name                      |
| Logical organization |     10 | Section order, chronology, dates, gaps, completeness, market norms    |
| Visual presentation  |      5 | Scannable role headers, hierarchy, whitespace, density, page breaks   |
| Writing              |     10 | Spelling, specific language, concision, consistency, varied structure |
| Parsing readiness    |     15 | Text recovery, reading order, intact fields and terminology           |

Rate each assessed criterion except Achievement bullets with an integer
from 0–4:
0 = absent or unusable; 1 = major weaknesses; 2 = mixed quality;
3 = solid with limited weaknesses; 4 = strong with no material weakness.
Explain each rating with located CV evidence and category-specific reasoning.

## Positioning

A recruiter's first pass reads the top third of page 1 and each role's
title, company, and dates. Rate Positioning on whether that area alone shows
the target title, specialty, and one strong proof. A missing summary is not
a deduction. A present summary takes that space, so a generic one lowers
Positioning: no summary beats a generic one. Audit a present summary for
identity, specificity, evidence, relevance, and concision with a separate
0–4 diagnostic rating. Generic means the patterns in
`job-resume-refine/references/formats/format-summary.md` "Not a summary",
or a summary about what the candidate wants rather than offers. Note,
without deducting, a summary over about 90 words or one in first person.
An objective statement suits students and career changers.

## Achievement bullets

Rate every experience/project bullet on the same 0–4 scale:
0 = no intelligible contribution;
1 = generic duty or unsupported claim, such as "responsible for", "helped
with", "worked on", or "involved in" with no outcome;
2 = specific action/context but unclear ownership or value, or a process
count (pull requests, commits, lines of code, tickets) as the only result;
3 = clear contribution with useful scope or concrete outcome; a percentage
or multiplier with no baseline, scale, or timeframe stops here;
4 = clear contribution, context, and convincing value with a result an
interviewer could probe, expressed concisely.
Bullets in the two most recent roles (latest end dates, current roles
first) weigh 2; other bullets weigh 1. The category rating is the weighted
mean. A CV with no achievement descriptions rates 0. Assess equivalent
achievement descriptions when experience uses paragraphs, one location
per paragraph.

Concrete qualitative outcomes can earn full credit. Numbers and method
details are useful when meaningful; neither is compulsory in every bullet.
Note, without changing the rating, a bullet that bundles several
accomplishments or a round figure with no stated basis.

## Skills and relevance

Distinguish experience evidence from a skill-list claim. A Skills entry no
role or project names is listed-only: parsers infer a skill's duration and
recency from the roles that mention it. Facts absent from the CV remain
visibility gaps; absence is not proof the candidate lacks them.

## Organization and market norms

Judge length, section order, and presentation in the stated career and
market context. Avoid universal page-count, sentence-count, or font-size
penalties. Each of the first three items below lowers Logical
organization; the last is reported without a deduction:

- an unexplained gap of more than six months between roles, with the
  question to resolve;
- an employer a recruiter in the target market is unlikely to know, with no
  line on what it does or its size;
- for US, UK, Canadian, Brazilian, or remote-international targets, a photo,
  date of birth, marital status, national ID (CPF, RG, SSN), or full street
  address; state the norm applied for other markets, and apply the
  remote-international norm when no target market is known;
- when the target market differs from residence, whether work
  authorization, time zone, or contractor/EOR availability is visible. A
  missing line is a visibility gap, never an assumed answer.

## Writing

List every misspelling or wrong word as an observed defect at the top of
the fixes; two or more cap Writing at 2. `job-humanize/scripts/detect.py`
hits, and most bullets sharing one sentence shape, are AI-writing risks:
recruiters report them, but no field study yet links them to callbacks.
Together they lower Writing by at most one point.

## Parsing readiness

Lower the rating for each observed failure:

- a page with no text layer;
- replacement (U+FFFD), private-use, control, or ligature code points in
  extracted text;
- words run together or split compared with the rendered page;
- a date range broken across lines, or a role's title, company, and dates
  separated in reading order;
- columns whose extraction interleaves;
- a file over 2.5 MB.

These risks do not prove that a given employer's parser fails.

## Blocking defects

A blocking defect makes the document unusable to a parser or a reader:

- no extractable text on any page;
- role headers or dates that extract out of order;
- text that extracts but is not visible on the rendered page;
- no email or phone number in the document body, including contact
  details that appear only in a page header or footer.

List each first in the fixes and pass it to `./scripts/review_score.py` as
`blocking`; the overall score is then capped at 40.

## Score

Pass the ratings to `./scripts/review_score.py` as one JSON object on stdin:

- `criteria`: `positioning`, `skills`, `organization`, `visual`, `writing`,
  and `parsing`, each an integer 0–4, or `null` when unassessed;
- `bullets`: one `{"id": "E1.B1", "rating": 0-4, "recent": true}` per
  bullet, with `recent` true in the two most recent roles; `[]` when the CV
  has none;
- `blocking`: one short string per blocking defect;
- `requirements`, with a posting: one `{"id": "R1", "kind": "must", "credit": 1}`
  per matrix row, `kind` being `must`, `preference`, or `unclassified` and
  `credit` 0, 0.5, or 1.

Exit 1 with `review_score_error` means the input is malformed; fix it and
rerun. Report the script's numbers, never hand arithmetic.

Weighted points = weight × rating / 4.
Overall score = 100 × earned points / assessed weight, rounded half up.
Coverage = assessed weight, as a percentage.
Any unassessed criterion makes the overall score provisional.
Do not compare totals with different assessed coverage as equivalent.

## Posting alignment

If a posting is supplied, create a separate requirement-evidence matrix.
Deduplicate requirements. Weight explicit must-haves 2 and preferences 1;
unclassified requirements receive weight 1.
Evidence credit: clear support in an experience or project 1; partial
support, or support only in Skills or the summary, 0.5; not demonstrated 0.
Alignment = credited weight / total requirement weight, as a percentage
rounded half up.
Return N/A when no assessable requirements exist.
Report outside the percentage: whether the headline title matches or
truthfully maps to the posting title; text copied from the posting word for
word; and a posting acronym or full form the CV never spells the posting's
way.
Report eligibility questions separately without assuming unknown answers.
