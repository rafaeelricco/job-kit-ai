# plan.json

One file per prepared posting at `scout/applications/{slug}/plan.json`. Written
only by `job-prep`; read by `job-apply/references/flows/flow-apply.md` §3 rule 0 and
by `job-prep digest`.

```json
{
  "schema_version": 1,
  "slug": "2026-09-03-acme--full-stack-engineer",
  "url": "https://boards.greenhouse.io/acme/jobs/4012",
  "ats": "greenhouse",
  "channel": "ats",
  "prepared_at": "2026-09-03T02:14:00Z",
  "cv": "/home/jane/profile/scout/applications/2026-09-03-acme--full-stack-engineer/Jane_Doe_Full_Stack_Engineer_Resume.pdf",
  "cv_sha256": "4c1f0b9a7d2e6c8f3a5b1d0e9f7c6b4a2d8e1f0c3b5a7d9e6f2c4b8a1d3e5f70",
  "fields": [
    {
      "selector": "#first_name",
      "label": "First name",
      "type": "text",
      "required": true,
      "value": "Jane",
      "source": "data/basics.yaml"
    },
    {
      "selector": "#job_application_answers_2",
      "label": "Salary expectation (USD/mo)",
      "type": "text",
      "required": true,
      "value": "7500",
      "source": "contract-screening.md salary row 3"
    }
  ],
  "needs_you": [],
  "submit_selector": "#submit_app",
  "walls": []
}
```

- `url` is the normalized URL per `job-store/references/schemas/schema-dossier.md`
  "URL normalize"; it is the identity rule 0 matches on.
- `slug` is the dossier filename minus `.md`.
- `ats` is the dossier's stored Posting-facts `ats` row
  (`job-store/references/schemas/schema-dossier.md` "ATS family"), or that
  section's rule applied to `url` when the row is absent; `null` when `channel`
  is not `ats`.
- `channel` is the dossier's frontmatter value.
- `prepared_at` is UTC ISO-8601 with a `Z` suffix.
- `cv` is an absolute PDF path: under `scout/applications/{slug}/` when
  `job-apply/references/flows/flow-apply.md` §3 rule 1 or 2 picked it, under `cv/`
  when rule 3 did.
- `cv_sha256` is the lowercase hex SHA-256 of the file at `cv`, taken when the
  plan is written. `job-apply/references/flows/flow-apply.md` §3 rule 0 refuses a plan
  whose `cv` bytes no longer match it, so a later refine cannot swap the
  approved PDF unnoticed.
- `fields[].source` is a Fact-file path, a `contract-screening.md` row, or a
  resolution-order name (`derived`, `authored`, `default`, `declined`).
  `authored` rows carry `"value": null`; job-apply fills them at apply time.
- The CV upload control is excluded from `fields[]`; top-level `cv` and
  `cv_sha256` identify the file represented in the package's `### CV` section.
- `needs_you[]` entries are `{ "what": "...", "why": "...", "where": "..." }`,
  what the resolution order could not fill; they print under
  `### Needs answers` in the prep report and digest.
- `walls[]` records a captcha or account wall seen on the apply path as a
  string; job-apply §5 clears it at apply time.
- `submit_selector` is recorded, never clicked, and `null` when not found.
- No prose, no cover letter, no score, no verdict.
