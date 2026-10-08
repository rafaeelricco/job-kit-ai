# Scout — persist set

Input: `status=live` rows that passed `./flow-gate.md`, with Rank `score`.

Drop to Gaps, no dossier:

- `score` is `—` → `unscorable: no requirements printed` when `required_skills` is `—`, else `unscorable: no profile skills`
- integer `score` ≤ 7 → `score<=7`
- then match (below) fails

Keep: integer `score` 8–10 and match decision at/above `possible_match` (`match_score` ≥ 70).

Match: resolve the installed `job-match` skill root, then derive CandidateProfile
once per its `references/schemas/schema-state.md`. Load `references/workers/worker-extract.md`,
`references/contracts/contract-match.md`, and `references/workers/worker-match.md`. The scorer is
`scripts/score.py`; resolve its Python 3 launcher per job-match
`references/flows/flow-match.md` **score**, and fan out per that flow. Per row,
that row's Verified extract is the posting body — never fetch, never open
Profile root.

extract → JobProfile. Malformed → Gaps, drop.
HF8 (`contract-match.md` hard filter 8, language) → Gaps `match blocked`, drop. Do not re-run hard filters 1–7; the scout gate applied them.
match → MatchResult. When the run carried `--typesafe`, run
`job-match/scripts/typesafe_match.py` (same launcher) with
`{"candidate": <CandidateProfile>, "jobs": <JobProfiles>}` on stdin instead of
the match worker; otherwise run the match worker. A row carrying
`match_error` → Gaps `match unavailable`, drop.
Then invoke the resolved scorer with
`{"candidate": <CandidateProfile>, "jobs": <JobProfiles>, "matches": <MatchResults>}`
on stdin. A row carrying `score_error` → Gaps; continue with the remaining rows.
A row whose scorer `confidence` is below `0.9`, or that carries a
`match_uncertain` list, was scored on collapsed cells:
load `job-match/references/workers/worker-validate.md`, re-review that row
alone, and re-score it before the bar below. Never drop a row on an uncertain
answer — uncertainty is a reason to look again, never a reason to discard.
`decision` below `possible_match` (`weak_match` or `skip`) after that review →
Gaps `match below bar`, drop.

Carry the scorer's `match_score`, `decision`, and `confidence` on each kept row as Posting-facts `match_score`, `match_decision`, and `match_confidence` (`job-store/references/schemas/schema-dossier.md`). Scout `score` stays the 0–10 skill share. Do not print the job-match report.

Output: persist-set rows (url + score + `match_score` + `match_decision` + `match_confidence` + extract fields unchanged). Unreadable
job-match reference or scorer, or no Python 3 launcher → name it and end; write
nothing this run.
