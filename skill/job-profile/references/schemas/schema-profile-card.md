# profile_card.yaml

Optional cache of the card `show` otherwise derives. Full rewrite: `card refresh`
via `flow-mutate.md` after diff → yes. Same-cycle clear of `primary_role` on a
`positions` write is also `flow-mutate.md`. job-scout may glob this file in.
`show` never prefers this cache for `primary_role` (always from `job_search.yaml`).

## Schema

```yaml
primary_role: ""
top_skills: []
industries: []
languages: []
summary: "" # 1-3 sentences, facts only
updated_at: "" # ISO date this file was written
```

## Derivation — files on disk only

| Field          | Source                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------- |
| `primary_role` | `job_search.yaml` `positions[0]`, else most recent `experiences.yml` `position`              |
| `top_skills`   | `skills.yaml` `skills[].items`, categories in file order; never re-ranked by judgement       |
| `industries`   | `experiences.yml` `industries[]` across roles, file order, deduped; else `[]`                |
| `languages`    | `languages.yaml` `languages[].name` + `level` verbatim; never invent a cert or numeric scale |
| `summary`      | 1-3 sentences built only from the fields above                                               |
| `updated_at`   | ISO date at write time                                                                       |

`experiences.yml` is a bare list at the document root and each `summary` is a
list of bullet strings.

Empty is allowed everywhere. Unknown stays `""` or `[]`. Never fill a field to make
the card look complete.
