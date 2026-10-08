# worker-match

Caller hands CandidateProfile JSON, MatchingPolicy (`contract-match.md` body),
and one or more JobProfile JSON objects, inline or as the files the brief names. Never fetch a
URL. Never change the policy. No dossier prose.

## Deltas

1. Open only the files the brief names; run no script, write no file. That JSON, policy text, and the MatchResult shape below are the whole evidence set.
2. For each JobProfile emit one MatchResult.

```json
{
  "url": "",
  "match_score": 0,
  "decision": "skip",
  "confidence": 0.0,
  "blockers": [],
  "strengths": [],
  "gaps": [],
  "score_breakdown": {
    "primary_stack": null,
    "experience": null,
    "seniority": null,
    "role_type": null,
    "location": null,
    "domain": null,
    "language": null,
    "preferences": null
  }
}
```

3. Fill `score_breakdown` per contract; unscored factor → JSON `null`. Leave
   `primary_stack`, `experience`, and `role_type` `null`, and
   `match_score`, `decision`, and `confidence` at their zero values — the caller
   computes them.
4. Every `strengths` / `gaps` / `blockers` item quotes a token from the two JSON objects.
5. Emit the JSON array, then stop.
