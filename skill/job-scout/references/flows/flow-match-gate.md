# Job scout — persist set

Input: `status=live` rows that passed `./references/flows/flow-gate.md`, with Rank `score`.

Every input row proceeds to Match below, including low or unknown Rank `score`.
Rank `score` is diagnostic only; it never filters a row.

Keep: match decision at/above `possible_match` (`match_score` ≥ 70)
after the existing validation and re-scoring below.
Drop to Gaps, no dossier, only for the Match failures defined below.

Resolve the installed `job-match` skill root and derive CandidateProfile once
per `job-match/references/schemas/schema-state.md`. Use
`job-match/references/flows/flow-score.md` for extraction, the required language
filter, matching, scoring, and review. The scout gate already applied the
eligibility filters.

Use the Verified extract as the posting body. For a row marked
`board_api_branch: true`, also supply its complete run-local JD from the
extract step, including the same-posting browser fallback body when used.
Keep that full body run-local, outside the dossier schema. Prepare the
structured facts for matching without compensation fields. Workers receive only supplied
text and facts. They never fetch, open a browser, or open Profile root.

Send a language block to Gaps as `match blocked`. Send a TypeSafe failure to
Gaps as `match unavailable` and drop the affected rows. Review a row whose
`confidence` is below `0.9` or that carries a `match_uncertain` list.

A final decision below `possible_match` (`weak_match` or `skip`) goes to Gaps as
`match below bar` and is dropped.

Carry the scorer's `match_score`, `decision`, and `confidence` on each kept row as Posting-facts `match_score`, `match_decision`, and `match_confidence` (`job-store/references/schemas/schema-dossier.md`). Scout `score` stays the 0–10 skill share. Do not print the job-match report.

Output: persist-set rows (url + score + `match_score` + `match_decision` + `match_confidence` + extract fields unchanged). Unreadable
job-match reference or scorer, or no Python 3 launcher → name it and end; write
nothing this run.
