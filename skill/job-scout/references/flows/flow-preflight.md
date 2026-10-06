# Job scout — preflight

Print `Profile root:`, `Deck:` (`data/search_packs.yaml`), `Runtime: workers` if spawn works, else `inline`.

`job_search.yaml` keys: `work_model`, `job_types`, `date_posted`, `positions`, `location` (`search_in`, `exclude_hire_from`), `market_currencies`, `exclude_companies`, `prune_score_max` (job-prune's threshold; scout ignores it), and the job-apply fact keys `employment_routes`, `salary_expectations`, `salary_history`, `availability`, `consents`. A valued `screening_defaults` or `work_authorization`, or any other valued key, top-level or under `location` → stop; migrate via `/job-profile`.
`data/candidate.yaml` present → stop; migrate via `/job-profile`.
Presence of `location.also_eligible_from` or `direct_regions`, including empty values, → stop; migrate via `/job-profile`.
Load `job-profile/references/contracts/contract-geography.md`; resolve `data/basics.yaml` `country` through its helper before matching. Missing or unresolved country → stop; run `/job-profile continue fill basics.country`.
`location.search_in` is `worldwide` or a nonempty list of places; empty → stop. Below, `worldwide` and "a `search_in` list" name these two cases.

Enabled packs empty and no URL token → STOP; enable via `/job-profile`. `enabled: false` is unlisted.
Tokens after `/job-scout` bind the run set (enabled deck `id:`). A token that
is an http(s) URL or bare domain binds an ad-hoc pack instead: `source` = its
host, `id` = its host (`-2`, `-3` on collision), `entry` = the URL (`https://`
assumed when bare), formulations = `[role]` — under every deck law (ATS-root,
filters, caps, defect log).
Empty → list as `N. {id}`; last line `{N+1}. Search in all`. Wait.
Any token → no wait. Run set: `all` → every enabled pack, else the named ids
(file order, unique by `id`), then each ad-hoc pack in token order (unique by
`entry` among ad-hoc packs). Two deck packs may share an `entry`.
Unknown `--` flag, leftover non-URL token, `all` plus a non-URL token, unknown id, or named disabled id → stop.
`refresh` is the one command, read before any pack `id`, and takes no other token (any beside it → stop). It binds no pack and skips search: the refresh set is every dossier in `scout/jobs/` whose frontmatter `status:` is `new` and whose latest posting-state line is not a closure (`job-store/references/flows/flow-read.md`), oldest `last_seen` first, capped at 40. Print `Refresh: {n} of {total}` and enter extract with those rows, each carrying its stored frontmatter and Provenance as its search columns. Fold each row's stored `source` through `job-store/scripts/normalize_source.py` before it becomes a search column. Host-shaped stored tokens (contain `.`) go in `ids` as well as `sources`, so a legal ad-hoc host outranks `ALIASES`; otherwise `ids` is `[]` and a drifted non-host spelling still folds. A refresh must not revive a retired non-host spelling.
Skip-wait → print `Packs: {id}, …` in run order.

Print `### Profile card` (role · skills · industries · languages) and `### Constraints` (the search keys above, through `exclude_companies`, plus salary_range_usd, citizenships, residence country, accepted employment_routes, relocation) — values per `job-profile` flow-show Blocks; scout adds no fields and prints no Packs/CV blocks. Pass both into every search, with the normalized residence country and derived regions from the geography helper. Keep citizenships and `basics.yaml` `permits` available to evaluate explicit posting authorization requirements.

Auth: existing session. Never create an account. Password/OTP/2FA are operator-only. Signed-out limited page → ask once only if the redirect stays on the target registrable domain or a known IdP (Google, Microsoft, Apple, LinkedIn, GitHub, Okta); any other host → STOP before asking. Still blocked → `auth_gate` (search) or `status=uncertain` (extract).
