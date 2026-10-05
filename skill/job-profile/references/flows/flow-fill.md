# Fill (apply questionnaire after emit)

Runs only after emit-tree succeeds and profile Approve is explicit (or on an
already scaffolded target when the operator says "continue fill"). Applies the
in-memory questionnaire buffer; it does not ask new profile questions except
the Edit continue-fill seed below.
Hard refuses: `../../SKILL.md`. Invent / propose-vs-ask: matrix below. Never invent.

## Source gate

### Edit continue-fill seed

When Edit `continue fill`:

1. Collect Source now (path / paste / scaffold-only), same modes as
   `flow-intake.md` **Source**, when the current request supplies a path,
   paste, or explicit scaffold-only — that Source replaces any Intake or
   prior-fill Source. When the request supplies none: collect Source now
   if there is no Intake or prior-fill Source; reuse the existing Intake
   or prior-fill Source otherwise.
2. Run **Resolve** below now, before the questionnaire, so path/paste SoT
   is in the session buffer. Reuse vs fresh read still applies.
3. Ask a questionnaire covering only the named fields when the operator
   named a blocker or a redirected Fact/identity field (experiences, skills,
   languages, projects, basics, profiles, identity). When none were named:
   salary / notice / visa / sponsorship / EOR / `legal_authorization.*` /
   `employment_routes.*`. Always ask this questionnaire for the current
   edit, even when a prior Intake or fill questionnaire remains.
   Chat-stated values are proposals; require confirm / edit / skip.
   Show source-derived values from the SoT buffer as proposals.
   On Edit, skip of a field that already has a non-empty on-disk value
   leaves that value unchanged. Empty writes stay for Init and for an
   explicit clear. This overrides Invent-matrix "skip leaves empty" for
   those fields.
4. Then continue this gate with that Source and buffer.

### Resolve

1. Resolve SoT from this gate's **Source** (paths and/or paste). Compute the
   **Source key** the same way as intake (sorted absolute path(s), or paste
   fingerprint).
2. Paths must exist and be readable. Unreadable → STOP; name path; ask again.
3. No path and no paste → continue only when the questionnaire was explicitly
   scaffold-only; otherwise STOP with the same follow-up as intake Source.
4. Chat memory alone is not SoT. Do not fill from "I think you said…".
5. **Reuse vs fresh read:**
   - Source key matches the intake (or prior fill) key **and** a session **SoT
     buffer** exists → reuse that buffer; do **not** re-read path files or re-parse
     PDF text.
   - Source key changed, or no buffer (e.g. **continue-fill** on a scaffolded
     target with no prior Identity ingest) → read each SoT file **once** here
     (PDF/text/md); full-ingest into the buffer; set the Source key.
6. Prefer quoted facts over paraphrase. Hold the buffer for questionnaire
   application; never re-read SoT as a second pass after the buffer is set.

## Invent matrix

| Class                                                                                                 | SoT present                                                                                                                                                                              | SoT silent                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Salary, notice, work auth, visa, sponsorship, EOR                                                     | Propose only verbatim / clear synonym, then require questionnaire confirmation                                                                                                           | Ask explicitly; skip leaves empty and may produce a Gap                                    |
| Routes (non-EOR), relocation (`availability.open_to_relocation`)                                      | Propose only when SoT prints a clear answer, then require confirmation                                                                                                                   | Ask explicitly; skip leaves empty; **do not** list under Gaps                              |
| Positions, `location.search_in`                                                                       | Propose from SoT only; questionnaire confirmation is required                                                                                                                            | Ask explicitly; skip → `[]`; Gaps per the allowlist below                                  |
| `location.also_eligible_from`, `location.exclude_hire_from`, `market_currencies`, `exclude_companies` | Propose only from SoT; confirm                                                                                                                                                           | Ask; skip → `[]`                                                                           |
| Search filters (`work_model`, `job_types`, `date_posted`)                                             | Propose only from SoT or template as **proposals**; require confirm/keep/edit                                                                                                            | Ask; skip → empty/`false` — **not** Gaps; never retain shipped template trues without keep |
| Experiences, skills, projects, languages, education (incl. levels, experience URLs)                   | Propose only what is printed, then require row/field confirmation                                                                                                                        | Ask explicitly; skip leaves `[]` / empty rows; **do not** list under Gaps                  |
| Story names (moment + employer link)                                                                  | Propose only titles the SoT prints as a role or project, then require confirmation                                                                                                       | Ask explicitly; skip → no stub; **do not** list under Gaps                                 |
| CV binary                                                                                             | Copy/place user file → `cv/en-us-resume.pdf` when a PDF SoT is given                                                                                                                     | Report only under **### CV** (not Gaps)                                                    |
| CV policy                                                                                             | Write questionnaire `adapt_per_vacancy` and the placed PDF's filename as `base` into `data/cvs.yaml`. Copy operator `.tex` → `cv/{base stem}.tex` when adapt is yes and they gave a path | Report only under **### CV** (not Gaps)                                                    |
| Identity (name, email, LI, GH)                                                                        | Tokens from **Approve** (SoT draft + operator fixes). Questionnaire confirmation required; do not clobber on fill                                                                        | Ask explicitly; required fields cannot be skipped                                          |

Hard: never default sponsorship/visa/EOR to `No` or `Yes` because it is convenient.
EOR bucket needs `employment_routes.employer_of_record: Yes` only when SoT or user says so.

## Apply questionnaire

Use the source buffer when available, but explicit questionnaire values always
win over extracted or template-provided proposals. Apply only confirmed values,
explicit skips, and confirmed pack enablement choices.

- Write all confirmed job-search (search and fact keys), basics, and collection (experiences, skills, projects, languages, education) fields.
- On Edit, write confirmed LinkedIn/GitHub usernames (and derived URLs) into
  `data/profiles.yaml`.
- Write `adapt_per_vacancy` and `base` on `data/cvs.yaml`.
- Write empty values/lists for explicit skips where supported, except the
  Edit keep-on-disk skip rule above.
- Keep typed defaults only when the questionnaire records explicit `keep`.
- Write one `data/stories/<slug>.md` stub per confirmed story name — `status: draft`,
  `company` set to the confirmed employer when it matches `data/experiences.yml`,
  else `""` for a confirmed project; every other field empty, no prose — and write
  the final observations response to `data/observations.yaml`.
- Do not rewrite identity tokens unless the operator corrects approved values,
  except the Edit `data/profiles.yaml` write above when identity was confirmed
  on this fill.

## Questionnaire-derived suggestions and packs

- Write only confirmed `enabled:` values on named packs. Never edit
  formulations, add a pack, or write a search term the operator did not type.
- Never write `enabled: true` on a `route_required: true` pack with no `route`;
  keep it disabled and say why.

## CV

1. If SoT includes a PDF resume/export: copy to `cv/en-us-resume.pdf` by path
   (overwrite only if user confirms when a different PDF already exists). Do not
   re-parse PDF text when the SoT buffer already holds facts.
2. PDF/LaTeX generation is a Hard refuse (`../../SKILL.md`). Non-PDF SoT → report under **### CV** only (not Gaps).
3. Write `data/cvs.yaml` `adapt_per_vacancy` from the questionnaire (never
   leave it implicit on a new profile) and `base` = the filename placed at
   step 1. No PDF at step 1 and adapt = yes with a `.tex` path → set `base`
   to `{tex stem}.pdf` (never leave `base` empty).
4. Adapt = yes and operator gave a `.tex` path: copy it to `cv/{base stem}.tex`
   (overwrite only on confirm). Missing path and missing dest → report under
   **### CV** (`no LaTeX base`); not a Gap.

## Post-fill leak gate

Both must pass before gap report / next-steps:

1. Same `rg '{{'` as emit-tree against target. Any hit → STOP; fix; do not hand off.
2. YAML-parse every `data/*.{yaml,yml}` touched this fill, and the frontmatter
   block of every `data/stories/*.md` touched this fill. Any parse error → STOP;
   fix; do not hand off.

## Gap report (required before next-steps)

```text
### Gaps
- <scout-critical only>: missing from SoT | needs operator | blocker skipped
### Filled
- <file>: <one-line what was written>
### Packs
- enabled: <ids or all>
- disabled: <ids or none>
### CV
- placed: yes path | no — operator must add cv/en-us-resume.pdf
- adapt_per_vacancy: true | false
- base: {filename or empty}
- latex: yes cv/{stem}.tex | no — job-resume-refine stops without it
### Stories
- stubs: <slugs, or none>
### Observations
- saved: yes data/observations.yaml | none
```

Partial fill is OK. **Gaps allowlist only** — omit a line when that key is filled:

- `salary_expectations.salary_range_usd`
- `availability.notice_period`
- `legal_authorization.*`
- `employment_routes.employer_of_record`
- `job_search` `positions`
- `job_search` `location.search_in` when empty

**Never Gaps:** `availability.open_to_relocation`,
`direct_contractor`, `local_employment`, empty
`projects.yml` / `languages.yaml` / `education.yaml` / experience `url.*`, `data/stories/`,
or CV (use **### CV**).
Blocker `skip` still emits a Gaps line
**only** when the skipped key is on this allowlist.
