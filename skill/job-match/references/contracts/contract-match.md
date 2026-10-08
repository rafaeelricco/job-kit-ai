# MatchingPolicy

Workers do not invent criteria.

## Hard filters (pass / fail)

First match wins → blocked. Do not invent auth paths.

1–7. Drop when the posting cannot hire this seeker: Posting facts `eligibility` reads `incompatible`; onsite or hybrid-without-remote place that matches no `location.search_in` entry (never under `worldwide` or an empty `search_in`); printed work_model that does not intersect kit-true flags (unknown → not a drop; no kit-true flag → not a drop), or named onsite place with no shared work_model flag (no kit-true flag → not a drop); remote permitted candidate locations incompatible with residence, or a known unmet explicit authorization requirement per `job-profile/references/contracts/contract-geography.md`; hire-from only in `location.exclude_hire_from`; salary currencies none of which are in `market_currencies`; company slug in `exclude_companies`. Blank is not a drop. Never infer authorization or currency from a company or country name. Hire-from is printed location, `work_auth`, `hiring_route`, `eligibility_evidence`, or a title country tag — never the company's country. Against `state.candidate.constraints` + JobProfile / Posting facts.

Load `job-profile/references/contracts/contract-geography.md`. Evaluate pasted-posting geography against `constraints.residence` through its helper; keep missing or unresolved geography and authorization unknown. Existing dossier `eligibility` is read as stored; this read-only flow does not rewrite dossiers or reinterpret stored incompatibility from a new residence fact.

8. Explicit language requirement `state.candidate.languages` cannot meet
   (printed must-have only; blank → not a block). Compare levels only when
   posting and profile print the same scheme; cross-scheme or incomparable
   tokens → unknown, not a block.

## Soft weights (sum = 100)

Cells are integers, or `—` for a factor with no evidence; never `0` for unknown.
Primary stack, Experience, and Role type are defined by comparison alone, so
`scripts/score.py` derives them from the CandidateProfile and JobProfile it
receives (Primary stack as raw `{"held": k, "required": n}` counts it rounds
half-up; a pre-rounded integer is invalid); workers leave those three cells `null`.
Workers fill the remaining cells; `scripts/score.py` computes `match_score`,
`decision`, and `confidence` from them, and drops any `strengths` / `gaps` /
`blockers` item that quotes no token from the two profiles.
Invalid cells receive a per-row `score_error`; they are never rounded or allowed
to abort the remaining batch.

| Criterion         | Weight | Points                                                                                                                                                                                                     |
| ----------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary stack     |     25 | `25 × \|∩\| / \|required_skills\|` (direct hold); either list empty → —                                                                                                                                    |
| Experience        |     20 | Code. Job token with no one- or two-digit integer → —; else min N = the first one (`6+ years`→6, `8-10 years`→8, `12+`→12, `1099 contract, 5+ years`→5); candidate ≥ N → 20; short → 10; either `null` → — |
| Seniority         |     15 | Same printed token as JobProfile `seniority` in `experience[].position` → 15; one step on intern–junior–mid–senior–staff–principal → 8; posting token not on that ladder → —; else 0. Job `null` → —       |
| Role type         |     15 | Code. JobProfile `title` contains a `candidate.roles[]` string (case-insensitive, punctuation ignored) → 15; else 0. `roles` empty → —                                                                     |
| Location / remote |     10 | Shared `work_model` and (remote or named-location match) → 10; shared `work_model` only → 5; else 0. Both unknown → —                                                                                      |
| Domain            |      5 | Printed domain cue holds in `candidate.domains` → 5; cue present, no hold → 0; no cue → —                                                                                                                  |
| Language          |      5 | Soft extra (not HF8) met → 5; printed extra unmet → 0; none → —                                                                                                                                            |
| Preferences       |      5 | `candidate.preferences` agree with JobProfile `work_model` / `location` → 5; conflict → 0; all blank → —                                                                                                   |

## Decision bands

| match_score | decision        |
| ----------: | --------------- |
|      90–100 | excellent_match |
|       80–89 | strong_match    |
|       70–79 | possible_match  |
|       50–69 | weak_match      |
|         <50 | skip            |

## Skill hold

Direct only: `React.js` covers `React`; Vue does not. Never adjacent transfer here.
