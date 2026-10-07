# Review report

Present the following, translating labels into the report language except
the score line and table header cells, which stay as written so tools can
read them:

1. Reviewed artifact, target context and its source, and rubric version.
2. The `./scripts/review_score.py` result on one line:
   `Score: {score}/100 · coverage {coverage}% · {final|provisional}`,
   adding ` · capped from {weighted_score}` when capped.
3. Blocking defects and spelling errors, if any.
4. Category table `| Criterion | Rating | Points | Evidence |`, with points
   as `{earned}/{weight}`.
5. Summary audit, or explanation of how positioning works without one.
6. Bullet table `| Location | Weight | Rating | Finding |`, one row per
   experience/project bullet in CV order, strong bullets included. Location
   is `E{role}.B{bullet}` for experience and `P{project}.B{bullet}` for
   projects, numbered from 1, top to bottom. Below the table, give a concrete
   improvement direction for each bullet rated 2 or lower.
7. Organization, market, visual, parsing, and factual-consistency findings.
8. If a posting is supplied, the alignment score and the matrix
   `| Requirement | Weight | Evidence | Credit |`.
9. Independent hiring assessment: perspectives completed, public-research
   coverage and limitations, strongest reasons to advance, supported
   objections and counterevidence, and unresolved disagreements. Cite CV
   locations and public sources. Give a provisional recommendation to
   advance to interview, gather more evidence, or not advance on the current
   evidence, explaining what would change it.
10. Prioritized fixes ordered by severity and likely benefit. Each names who
    acts: edit the base CV; `/job-stories add` when a bullet lacks a verified
    outcome number; `/job-resume-refine` for posting-specific Summary or
    Skills coverage; the LaTeX source or template for parsing defects;
    update the personal website or relevant public work when hiring evidence
    is missing there. For each hiring-evidence gap, name the concern, the
    evidence needed, where it belongs, and the question to resolve before
    adding it. Distinguish existing evidence to surface from evidence or
    experience still to develop. Recommend actions without performing them.

Separate observed defects from suspected risks and unassessed areas.
For missing evidence, specify the question to resolve rather than inventing
a metric, outcome, credential, title, or skill.
Give no replacement wording or projected score gains.
