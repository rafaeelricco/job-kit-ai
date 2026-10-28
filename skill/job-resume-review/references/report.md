# Review report

Present the following, translating labels into the report language except
the score line and table header cells, which stay as written so tools can
read them. Keep each section short enough to scan; prefer one-line cells
over paragraphs.

1. Header: reviewed artifact; target context and its source; rubric version.
2. The `./scripts/review_score.py` result on one line:
   `Score: {score}/100 · coverage {coverage}% · {final|provisional}`,
   adding ` · capped from {weighted_score}` when capped.
3. At a glance: three to five bullets derived from facts already established
   (blocking status, spelling count, bullet-strength pattern, listed-only
   skills, or the single strongest risk). No new judgments here.
4. Category table `| Criterion | Rating | Points | Evidence |`, with points
   as `{earned}/{weight}`. Evidence is one short takeaway per row. Add a
   nested bullet under a row only when that detail changes the rating
   (summary audit for Positioning; market, layout, or extraction finding
   for organization, visual, or parsing).
5. Bullets that need work: table
   `| Location | Weight | Rating | Finding | Direction |` with one row per
   experience/project bullet rated 2 or lower, in CV order. Location is
   `E{role}.B{bullet}` for experience and `P{project}.B{bullet}` for
   projects, numbered from 1, top to bottom. Finding is what is weak;
   Direction is one concrete improvement (no replacement wording). When
   every bullet is rated 3–4, write that none need work. Below the table,
   state how many bullets rated 3–4 were omitted; list them only if the
   user asks for the full table. Score every bullet for the Achievement
   category regardless of table omission.
6. If a posting is supplied, the alignment score and the matrix
   `| Requirement | Weight | Evidence | Credit |`.
7. Recruiter read: present the content `./references/rubric.md` requires as
   Call (advance / unsure / not advance); For; Against; Hesitations (up to
   three, each with location and resolving question); plus factual-
   consistency findings. Keep each line short.
8. Do next: prioritized fixes ordered by severity and likely benefit. Lead
   with up to three immediate actions as a numbered list. Each names who
   acts: edit the base CV; `/job-stories add` when a bullet lacks a verified
   outcome number; `/job-resume-refine` for posting-specific Summary or
   Skills coverage; the LaTeX source or template for parsing defects; the
   LinkedIn profile when it disagrees with the CV. Recommend actions
   without performing them.

On request only, after item 8:

- Career positioning: advertised versus supported level, evidence and
  uncertainty, supported role directions and company/industry contexts,
  and gaps relative to the target or supplied ambition.
- Recruiter search visibility: the illustrative query and the table
  `| Surface | Term | Evidence | Finding |`.
  Keep CV and public-page findings separate and state snapshot/access limits.
- Public work: findings per link read, separate from CV evidence, with
  access limits.

Separate observed defects from suspected risks and unassessed areas.
For missing evidence, specify the question to resolve rather than inventing
a metric, outcome, credential, title, or skill.
Give no replacement wording or projected score gains.
