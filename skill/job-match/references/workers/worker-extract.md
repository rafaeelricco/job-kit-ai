# worker-extract

Caller hands one or more excerpts, inline or in the one slice file the brief names: dossier slice (Posting facts + `## The role` +
frontmatter `company` / `title` / `url` / `score`) or one supplied posting body
already in the brief. Never open Profile root. Never fetch a URL. Never score.

## Deltas

1. Open only the files the brief names; run no script, write no file. Those excerpts and the JobProfile shape below are the whole evidence set.
2. For each excerpt emit one JobProfile. Facts `—` → `null` / `[]`. A token not in the excerpt is absent.
   `languages_required` / `languages_preferred` items are `{name, level}` (`level` null when unprinted).

```json
{
  "url": "",
  "company": "",
  "title": "",
  "scout_score": null,
  "seniority": null,
  "work_model": null,
  "location": null,
  "salary": null,
  "years_experience": null,
  "work_auth": null,
  "hiring_route": null,
  "eligibility": null,
  "eligibility_evidence": null,
  "required_skills": [],
  "preferred_skills": [],
  "languages_required": [],
  "languages_preferred": [],
  "domain": null
}
```

3. Do not emit `match_score`, `decision`, `strengths`, `gaps`, or `blockers`.
4. Emit the JSON array, then stop.
