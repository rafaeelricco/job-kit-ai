# Refine report

Write `{dir}/match-report.md` and print it. `job-apply` reads `verdict:` and
the `miss:` line; the remaining fields are for the operator. The extraction
CLI's full JSON schema belongs only to
`../contracts/contract-extraction.md`.

    # Refine · {company} · {title} · {YYYY-MM-DD}

    verdict: **PASS**

    source: {dossier filename} | live URL, no dossier | pasted ad text
    guidance: job-match/v1 · consumed | fallback · {reason}
    baseline: {compiled source page count}p · source sha256 {hash} · compiled pdf sha256 {hash}
    preservation: roles {recovered}/{expected} · raw bullets {recovered}/{expected} · identity {PASS|FAIL} · education {PASS|FAIL} · employers {PASS|FAIL} · locations {PASS|FAIL}
    bullets: {expected} preserved byte-for-byte · roles: {expected} preserved in order
    summary: recomposed sentences 1+3 | base block kept | base has none
    skills: {count} visible tokens · {in} in · {out} out · ad terms {hit}/{total}
    page: {final pages}/{compiled baseline pages} · base PDF stale: {yes|no}
    parse: default {blocks recovered}/{blocks total} blocks, {terms matched}/{terms total} terms · layout {blocks recovered}/{blocks total} blocks, {terms matched}/{terms total} terms
    extraction: {PASS|FAIL|ERROR} · sha256 {final PDF hash} · report extraction-report.json
    eligibility: {supported|conflicting|unknown|not stated} · informational only · {reason}
    diagnostics: {path or —} · warnings: {count or none}
    miss: {required or preferred exact term, …} | _(none)_

`terms total = 0` is printed as `n/a`, never as an ATS score. Keep the
existing `verdict:` and `miss:` fields even when a stop or evaluator error
prevents a complete report. A base factual or `never_say` issue is a `FAIL`
and names the preserved source text. Unsupported job requirements and
eligibility conflicts are informational and do not invalidate a correct PDF.

## Changes

List only permitted surfaces and verification repairs. Never report a dropped,
reordered, reworded, or added bullet or role because those operations are
forbidden.

| change             | what                                 | why                                                                                            |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Skills             | `{term}` in/out/exact spelling       | supported requirement / ad-silent fit removal / supported alias                                |
| Summary            | sentence `1` or `3`                  | supported requirement, truthful duration, or recent Fact proof                                 |
| Technologies       | `{company}` · `{term}`               | role-specific `skills-by-company` or matching Fact evidence                                    |
| title/date display | `{company}` · `{before}` → `{after}` | truthful source-grounded expansion preserving seniority, progression, endpoints, and precision |
| extraction repair  | `{surface}` · `{diagnostic code}`    | demonstrated final-PDF extraction failure; source and visual checks rerun                      |
| baseline issue     | `{source block}`                     | preserved base conflict; cannot be edited under this contract                                  |

Empty Changes → `_(none)_`.

## Requirement evidence

One row per printed required or preferred posting requirement. Include every
missing supported term and every unsupported or ambiguous requirement as a
diagnostic. `coverage` has one value: `exact`, `alias-only`, or `missing`.
Visible wording/location may point to Summary, Skills, Technologies, or an
existing immutable role bullet; preserved bullet evidence counts. A missing
Fact or ambiguous employer association is stated rather than guessed.

| requirement         | priority             | Fact evidence        | role evidence    | visible wording/location                                        | coverage                     | reason                                          |
| ------------------- | -------------------- | -------------------- | ---------------- | --------------------------------------------------------------- | ---------------------------- | ----------------------------------------------- |
| `{posting wording}` | required / preferred | `{source path or —}` | `{company or —}` | `{wording · Summary / Skills / Technologies / existing bullet}` | exact / alias-only / missing | `{covered, unsupported, ambiguous, or missing}` |

## Extraction diagnostics

The adjacent `extraction-report.json` is the evaluator output from
`contract-extraction.md`. This report summarizes its default and layout counts
and keeps the diagnostics path, warnings, page, and excerpt information when
available. Source byte comparison and visual review are separate checks and
must be named here:

    source comparison: PASS | FAIL · {immutable block or reason}
    visual review: PASS | FAIL · {page or reason}

If this run fails with no prior package, keep the failed `match-report.md` and
any available evaluator diagnostics JSON, but remove the failed `.tex` and `.pdf`. If a
prior package exists, print diagnostics and restore it, including the absence
of an extraction report in a legacy package.
