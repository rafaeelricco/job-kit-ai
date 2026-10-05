# Job scout — rank

`score` 0–10 = 10 × covered ÷ `required_skills` count, rounded half up (`3` of `4` → `8`), where covered counts the `required_skills` that `data/skills.yaml` `skills[].items` hold. Covered is direct, not adjacent — `React.js` covers `React`, Vue does not. Either list empty → unscored (`—`); the persist set reports it as Gaps `unscorable`, never as `score<=7`. Never invent requirements from the profile to score it.

Bucket, first match — dossier frontmatter only, never chat: printed EOR route and kit EOR Yes → `EOR`; printed contractor/B2B and kit contractor Yes → `direct`; `eligibility` is `incompatible` → `restricted-geo`; a route is printed and each printed route is one the kit refuses (EOR, kit EOR not Yes; contractor/B2B, kit contractor not Yes; local employment, kit local employment No) → `unbucketed`; `eligibility` is `confirmed` → `direct`; else `unbucketed`. Bucket never re-matches location; geography is the `eligibility` row.

Persist set = `./references/flows/flow-match-gate.md`. Chat lists that set, score desc. No other sort.

`# Job Scout · {YYYY-MM-DD} · {n} live · {n} contacts · {n} defects`

- `live` = persist-set size
- `contacts` = public email or @handle on those rows
- `defects` = pack verdicts `defect: {name}` and `auth_gate`

Then each persist-set row:

`{score}  {company} — {title}`
`   {url}`

Then `{n} dossiers → {abs Profile root}/scout/jobs/`

`### Gaps` — skipped, tool defects, uncertain, extract invalid, kit drop, unscorable, score≤7, match below bar, match blocked, match unavailable. Omit if empty.
