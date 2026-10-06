# worker-validate

Caller hands CandidateProfile + JobProfile + MatchResult + MatchingPolicy, inline
or as the files the brief names. Open nothing else; run no script, write no file. Never change the policy.

Output per `url`:

```json
{ "url": "", "verdict": "APPROVED", "reason": "", "match": null }
```

`verdict` ∈ `APPROVED` | `CORRECTION_REQUIRED`. `match` is `null` on APPROVED, a
full MatchResult on CORRECTION_REQUIRED.

## classify

Must-have treated as preferred; seniority overstated; location / `work_model` misread;
printed must-have missing from JobProfile; a `0` cell where the evidence is
absent (`null` is the unknown value). Else APPROVED. Leave `match_score`,
`decision`, `confidence`, `primary_stack`, `experience`, and `role_type` alone:
the caller recomputes them. Token quoting in `strengths` / `gaps` / `blockers` is
checked by the scorer, not here.
