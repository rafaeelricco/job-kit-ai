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
   Direction is one concrete improvement. When
   every bullet is rated 3–4, say that none are rated 2 or lower. Below the table,
   state how many bullets rated 3–4 were omitted; list them only if the
   user asks for the full table. Consider material improvements to stronger
   bullets in Do next. Score every bullet for the Achievement category
   regardless of table omission.
6. If a posting is supplied, the alignment score and the matrix
   `| Requirement | Weight | Evidence | Credit |`.
   Follow the current alignment matrix with `| Requirement | Support | Source | Visibility | Next action |` from validated ResumeEvidence v1. Highlight the strongest directly supported job-relevant CV achievement even if writing rating is 3–4; quote exact source and location. Prefer required over preferred requirements, then stronger support, then CV order. Say when no direct proof exists. Keep relevance separate from writing quality and private evidence separate from recruiter-visible proof.
   Put proposed wording in Do next. Every evidence source must resolve to a verbatim contiguous excerpt and exact CV bullet location or Profile file/role/field index, inline or in a source legend. Preserve these after the writing pass; an employer or source ID alone is insufficient, and quoted text must not contain inserted ellipses.
7. Recruiter read: present the content `./references/rubric.md` requires as
   Call (advance / unsure / not advance); For; Against; Hesitations (up to
   three, each with location and resolving question); plus factual-
   consistency findings. Keep each line short.
8. Do next: select actions by materiality first, then present up to three,
   prioritizing accuracy, target clarity, and visible evidence. An action
   needs a specific, evidence-backed reader-facing problem: a factual defect,
   material ambiguity, or target-relevant proof that is missing or obscured.
   Consider the full current passage and nearby visible evidence before
   deciding that a problem exists. Actions may address any CV region and
   stand independently of ratings or a supplied posting.
   For each, give the location and use the labels Current, Proposed,
   Rationale, and Sources. Mark missing current content explicitly for
   insertions. Give a supported proposal and explain its reader-facing benefit. Prefer structural arrangements when they solve the
   problem better than forced rewrites. Keep source/current quotations verbatim
   and separate from proposed wording. Identify private facts that are absent
   from the CV; preserve attribution, scope, and source restrictions. When
   combining facts, preserve their sourced relationships without inventing
   a link between components. Use Proposed only for wording ready to paste from cited
   facts. Verify source locators: use zero-based array indexes, or an
   unambiguous ordinal and exact quotation. Put claims needing confirmation
   in a separate Question, including relationships that would otherwise
   appear in a conditional draft. Uncertainty blocks only the affected claim:
   propose the supported part rather than withholding a useful safe rewrite.
   Explain how each proposal resolves its identified problem. Unused source
   facts, optional detail, non-deducting observations, or a possible rating
   increase alone do not establish a problem. A missing number alone is not
   an editing task when the contribution and useful outcome are already
   clear; explain a concrete value or target-fit ambiguity before requesting
   quantified scope or impact. When current content already
   makes positioning, contribution, outcome, and scope clear, explicitly
   recommend retaining it; give zero actions if none passes this gate.
   Keep optional interview questions in Recruiter read rather than turning
   them into CV-editing tasks. If no action passes, Do next contains exactly
   one sentence recommending retention of the current CV. Add no bullets,
   optional edits, conditional follow-ups, or future-tailoring suggestions
   to that section. Three is a ceiling, never a quota.
   Use factual text rather than placeholders in candidate wording. Each action names
   who acts: edit the base CV; `/job-stories add` when useful contribution or
   outcome needs evidence; `/job-resume-refine` for posting-specific Summary or
   Skills coverage; the LaTeX source or template for parsing defects; the
   LinkedIn profile when it disagrees with the CV. Recommend actions without
   performing them. Parent reviewer authors proposed wording; shared
   diagnostics remain trusted sources and actions.

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
a metric, outcome, credential, title, or skill. Give no projected score gains.
