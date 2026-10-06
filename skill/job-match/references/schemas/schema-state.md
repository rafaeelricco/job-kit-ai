# Match state

Orchestrator holds this object in-session, or as JSON files in the run-scoped temp
directory `SKILL.md` names — never under Profile root. Nodes write only their keys.
Pipe those files to the scripts; never retype their JSON.

```json
{
  "candidate": null,
  "jobs": [],
  "blocked": [],
  "matches": [],
  "guidance": [],
  "gaps": []
}
```

`blocked[]`: `{ "company", "title", "url", "reason" }`.
`guidance[]`: valid ResumeGuidance rows from `./references/contracts/contract-resume-guidance.md`.
`gaps[]`: `{ "url" | "path", "reason" }`.

## CandidateProfile

`state.candidate`. Derive once from disk. Workers never re-read Profile root.

| Field                            | Source                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles`                          | `job_search.yaml` `positions[]`                                                                                                                                                                                                                                           |
| `skills`                         | `job-profile/references/schemas/schema-profile-card.md` `top_skills`                                                                                                                                                                                                      |
| `domains`                        | same file, `industries`                                                                                                                                                                                                                                                   |
| `languages`                      | same file, `languages` as `{name: level}`                                                                                                                                                                                                                                 |
| `experience`                     | `experiences.yml` `date` · `position` · `company` per role; no `summary`                                                                                                                                                                                                  |
| `years_experience`               | Run `./scripts/years.py` (launcher as **score** in `./references/flows/flow-match.md`) with `{"dates": [...]}` from `experience[].date`; take its `years` (`null` stays `null`, not 0). This script is the one years rule: every skill that states a years figure runs it |
| `preferences.remote`             | `job_search.yaml` `work_model.remote` or `work_model.hybrid` true → `Yes`, else `No`; no `work_model` flag true → `""`                                                                                                                                                    |
| `preferences.in_person`          | `work_model.onsite` or `work_model.hybrid` true → `Yes`, else `No`; no `work_model` flag true → `""`                                                                                                                                                                      |
| `preferences.relocation`         | `job_search.yaml` `availability.open_to_relocation`                                                                                                                                                                                                                       |
| `constraints.work_model`         | `job_search.yaml` `work_model`                                                                                                                                                                                                                                            |
| `constraints.location`           | `job_search.yaml` `location` (`search_in`, `exclude_hire_from`)                                                                                                                                                                                                           |
| `constraints.residence`          | Run `job-profile/scripts/geography.py` with `data/basics.yaml` `country` per `job-profile/references/contracts/contract-geography.md`; copy only `country` and `regions`. Missing or unresolved residence stops matching.                                                 |
| `constraints.exclude_companies`  | `job_search.yaml` `exclude_companies`                                                                                                                                                                                                                                     |
| `constraints.market_currencies`  | `job_search.yaml` `market_currencies`                                                                                                                                                                                                                                     |
| `constraints.work_authorization` | `{ "citizenships": basics.yaml citizenships, "permits": basics.yaml permits }`, each verbatim; never merged, since screening treats them differently                                                                                                                      |

```json
{
  "roles": [],
  "skills": [],
  "domains": [],
  "languages": {},
  "experience": [{ "date": "", "position": "", "company": "" }],
  "years_experience": null,
  "preferences": { "remote": "", "in_person": "", "relocation": "" },
  "constraints": {
    "work_model": {},
    "location": { "search_in": [], "exclude_hire_from": [] },
    "residence": { "country": null, "regions": [] },
    "exclude_companies": [],
    "market_currencies": [],
    "work_authorization": { "citizenships": [], "permits": [] }
  }
}
```

Empty stays `""` / `[]` / `null`. Never fill to look complete. No `seniority` key — matchers read `experience[].position`.

## JobProfile

Extractor output. Unknown → `null` or `[]`. Copy printed tokens only.

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

Store excerpts arrive with the Posting-facts keys, `url` / `company` / `title`, and `scout_score` already copied by `job-store/scripts/slice_store.py` (`—` → `null`). Human-language names printed under **Must have** → `languages_required` as `{name, level}` (`level` null when unprinted); "advantage" / nice-to-have → `languages_preferred` the same way. Programming languages stay in `required_skills`. Other `preferred_skills` / `domain` from `## The role` only when printed. `scout_score` = frontmatter `score` (`—` → `null`).

## MatchResult

Matcher output.

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

`score_breakdown.primary_stack`, `experience`, and `role_type` are derived by
`scripts/score.py` from CandidateProfile and JobProfile; workers leave them
`null`. A scored `primary_stack` carries raw `{"held": <count>, "required": <count>}`
counts, never a pre-rounded integer.
