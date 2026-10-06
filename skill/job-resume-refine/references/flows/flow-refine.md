# Job resume refine — flow

Load `./references/contracts/contract-refine.md` now. Its six ATS steps are
the only home for refinement coverage policy. Load
`./references/contracts/contract-extraction.md` when the final PDF evaluator
is named; do not reproduce its manifest or JSON schema here.

## 1. Posting

The argument is one posting, in one of three forms:

| argument               | posting is                                     | `{slug}`                    |
| ---------------------- | ---------------------------------------------- | --------------------------- |
| `scout/jobs/` filename | that dossier, tailored from its live `url`     | filename minus `.md`        |
| a URL                  | the matching dossier, else the live page alone | that dossier's, else ad-hoc |
| pasted ad text         | the text itself; nothing to open               | ad-hoc                      |

Lookup obeys `job-store/references/schemas/schema-dossier.md` "URL normalize"
and its Slug rule. Never company+title: one company posts many roles. An
ad-hoc slug is `adhoc-{company}--{title}`; a dossier slug starts with an ISO
date, so the two never collide.

Two arguments, or a form no row matches → say which and stop without writing.
`status:` is not read here; `job-apply` gates its own chain on `status: new`.

Tailor from the live page whenever there is one. A dossier's `## The role` is
a snapshot that may have gone stale. Page dead (404, expired, filled,
withdrawn, or it prints that it is not accepting applications) → stop. Record
the company, title, required and preferred requirements, and every printed
domain, seniority, product, stack alias, and supported exact term.

## 2. Base and baseline

Read `data/cvs.yaml`. `adapt_per_vacancy: false` → stop and say refinement is
off. The caller owns CV selection: `job-apply` checks its prepared-plan and
fallback rules before attaching a base, while `job-prep` follows its own
prepared workflow.

Resolve `base` under `cv/`. Its source must be the same stem with a `.tex`
extension beside the base PDF:

| source beside the base PDF                         | this run                       |
| -------------------------------------------------- | ------------------------------ |
| `.tex`                                             | continue                       |
| another source (`.docx`, `.md`, `.odt`, `.rtf`, …) | stop; name the format and path |
| no source; PDF stands alone                        | stop; a PDF is not a source    |

Read, do not write: `data/experiences.yml`, `data/skills.yaml`,
`data/skills-by-company.yml` when present, `data/languages.yaml`,
`data/basics.yaml`, and `data/stories/*.md` frontmatter. Story bodies stay
closed. An empty story deck is normal. `job-profile` is the interactive editor
for these files; refinement never opens a write prompt. Report the base PDF's
page count and whether it is older than its `.tex`; neither fact replaces the
compiled baseline.

Before any application-package mutation, follow the baseline procedure in
`contract-refine.md`: use run-scoped temporary storage for an untouched source
copy, freeze the complete ordered role/bullet inventory with stable expected
block IDs and immutable manifest entries, and compile the copy with the same
resolved `TEXINPUTS` and
`pdflatex -interaction=nonstopmode -halt-on-error -output-directory=...`
command shape used for the final source (with the baseline temp directory as
output). Resolve preamble inputs with `kpsewhich`,
the baseline temp directory, `cv/`, and a trailing `:`. Record source/PDF
hashes, page count, and log result. That compiled page count is the ceiling
even when the checked-in base PDF is stale. A source or copied-preamble
failure is an explicit stop; do not edit the baseline source or preamble to
make it pass.

## 3. Target and guidance

Resolve the installed `job-match` root and load its CandidateProfile and
JobProfile schemas, extractor, `ResumeGuidance` contract, guidance worker, and
validator. Derive the thin CandidateProfile from the Facts already read in
§2. Extract one JobProfile from the current posting resolved in §1; never
fetch it again. Scaffold one `ResumeGuidance` with
`job-match/scripts/scaffold_guidance.py`, have the guidance worker classify it,
and validate it without hard filters, scoring, ranking, or an apply/no-apply
decision.

Resolve every non-held requirement against the complete refine Fact set before
using it. Valid guidance may prioritize existing Skills, Summary edits, and
visible coverage. It cannot supply wording, provenance, role association, or
permission to touch an immutable role or bullet. Missing or invalid guidance
is discarded as a whole. Continue under the posting-led contract and record
`guidance: fallback`; guidance failure alone is never STOP or FAIL.

## 4. Draft and package rollback

`{stem}` = slugify(`basics.yaml` name) `_` slugify(title) `_Resume`.
Slugify: letters and digits stay, every other run becomes one `_`, edges
stripped. `_Resume` is the tailored-package marker. `{dir}` is
`scout/applications/{slug}`.

Create `{dir}` only after the baseline snapshot. Move any existing `*.pdf`,
`*.tex`, `match-report.md`, and `extraction-report.json` in `{dir}` to a
`.prev` suffix. These files are this run's rollback, including the possible
absence of `extraction-report.json` in a legacy package. A PASS removes the
backups only after both reports are complete and the extraction report's
`pdf_sha256` equals the final PDF hash. A stop or FAIL restores the old files
before returning.

Copy the base `.tex` to `{dir}/{stem}.tex` and apply `contract-refine.md` to
the copy. The immutable inventory and block IDs in the expected manifest were
frozen from source and Facts before this copy was edited; assemble or refresh
only editable entries from source and Facts, never from PDF extraction.

Load `./references/formats/format-summary.md` before drafting the Summary.

## 5. Summary humanization

Load `job-humanize` and obey it end-to-end once, with `Surface: summary`.
Paste `contract-refine.md` verbatim as `CONTRACT`. The `DRAFT` is Summary
sentences 1 and 3, including any selected exact terms and acronyms. The
contract locks those terms while humanizing; they must remain in the returned
text. Sentence 2, role fields, bullets, Skills tokens, headings, and
Technologies lines stay out of the rewrite. If no Summary was present in the
base, skip this surface. There is no resume-bullet humanization pass: raw
bullet bytes are immutable. Refresh only the editable manifest entries after
this pass; immutable block IDs and expected parts remain fixed.

## 6. Compile, fit, and verify

Set `TEXINPUTS` to the `kpsewhich` directory for each preamble `\input{...}`
not already in `{dir}` or `cv/`, then `{dir}`, then `cv/`, then a trailing `:`.
Compile with `pdflatex -interaction=nonstopmode -halt-on-error
-output-directory={dir} {tex}`, then run `pdfinfo` and a
visual page review. Missing binaries → stop and name them.

Apply the Fit order in `contract-refine.md` against the compiled baseline. A
targeted Unicode, ligature, text-separation macro, or per-vacancy preamble
repair follows that contract's demonstrated-failure, source-comparison, and
visual-recheck rule. After every later edit before final evaluation, including
fit or repair, refresh the editable manifest entries while leaving the frozen
immutable entries unchanged.

After the final fit, run the evaluator from
`./references/contracts/contract-extraction.md`:

```text
python3 ./scripts/evaluate_pdf.py /abs/{stem}.pdf < /run-temp/expected.json
```

Use its first available Python 3 launcher on the platform. It must complete
both default and layout modes and return `PASS`. Save its stdout unchanged as
`{dir}/extraction-report.json`; require its `pdf_sha256` to equal the final
PDF. The evaluator is required alongside source byte comparison and visual
review. Its warnings and diagnostics are retained even with `PASS`.

Separately compute informational posting eligibility from the source and
derivation rules in `job-apply/references/contracts/contract-screening.md`.
Missing evidence is `unknown`; report only `supported`, `conflicting`,
`unknown`, or `not stated`. Do not answer a form, stage a form value, or score
the candidate in this step. An unsupported requirement or eligibility conflict
is reported and does not invalidate a correct PDF.

## 7. Report and cleanup

Load `./references/formats/format-report.md`. Write `{dir}/match-report.md`
with the required verdict, miss line, immutable preservation counts, compiled
baseline page count, default/layout extraction counts, diagnostics path and
warnings, and the requirement evidence matrix. Preserve the source, guidance,
summary, Skills, page, and parse fields defined there.

Only after all source, extraction, page, and visual checks pass, both reports
are complete, and the extraction hash matches the final PDF,
remove `*.aux`, `*.log`, `*.out`, and all `.prev` backups. PASS output is
exactly:

    scout/applications/{slug}/
      match-report.md
      extraction-report.json
      {stem}.tex
      {stem}.pdf

On a failed new run, print extraction and source-comparison diagnostics before
rollback. Delete the failed `.tex` and `.pdf`, and restore the prior package,
including no `extraction-report.json` when the prior package was legacy. With
no prior package, leave `match-report.md` at `verdict: **FAIL**` and retain any
available `extraction-report.json` diagnostics; do not leave the failed `.tex` or
`.pdf`. A stop leaves no new PASS package.
