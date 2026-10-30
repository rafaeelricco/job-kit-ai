# Review report

Present the following, translating labels into the report language except
the score line and table header cells, which stay as written so tools can
read them. Keep each section short enough to scan; prefer one-line cells
over paragraphs.

Use `E{role}.B{bullet}` / `P{project}.B{bullet}` only for experience/project
bullets, numbered from 1, top to bottom. Use `E{role} header` / `P{project} header`
for headers and name other regions directly. Resolve evaluator block IDs through
expected text and the CV inventory before reporting a location; preserve that
location in recovery notes and findings.

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
   For every PDF, add a short recovery note after the table: the independent
   recovery verdict and source provenance, or why recovery was unassessed.
   Keep source/PDF disagreement outside the rating unless an existing rubric
   defect is also observed.
5. Bullets that need work: table
   `| Location | Weight | Rating | Finding | Direction |` with one row per
   experience/project bullet rated 2 or lower, in CV order. Finding is what is weak;
   Direction is one concrete improvement (no replacement wording). When
   every bullet is rated 3–4, write that none need work. Below the table,
   state how many bullets rated 3–4 were omitted; list them only if the
   user asks for the full table. Score every bullet for the Achievement
   category regardless of table omission.
6. If a posting is supplied, the alignment score and the matrix
   `| Requirement | Weight | Evidence | Credit |`.
   Follow the current alignment matrix with `| Requirement | Support | Source | Visibility | Next action |` from validated ResumeEvidence v1. Highlight the strongest directly supported job-relevant CV achievement even if writing rating is 3–4; quote exact source and location. Prefer required over preferred requirements, then stronger support, then CV order. Say when no direct proof exists. Keep relevance separate from writing quality and private evidence separate from recruiter-visible proof. Give no replacement resume prose or projected score gains.
   Every evidence source must resolve to a verbatim contiguous excerpt and exact CV bullet location or Profile file/role/field index, inline or in a source legend. Preserve these after the writing pass; an employer or source ID alone is insufficient, and quoted text must not contain inserted ellipses.
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
