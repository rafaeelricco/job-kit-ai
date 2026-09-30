# Job resume refine — flow

Load `./references/contracts/contract-refine.md` now.

## 1. Posting

Parse tokens per `job-store/references/contracts/contract-tokens.md`. This skill
declares no verb and takes exactly one posting, in one of three forms:

| argument                       | posting is                                     | `{slug}`                    |
| ------------------------------ | ---------------------------------------------- | --------------------------- |
| `scout/jobs/` filename         | that dossier, tailored from its live `url`     | filename minus `.md`        |
| a URL                          | the matching dossier, else the live page alone | that dossier's, else ad-hoc |
| `--posting`, or pasted ad text | the text itself; nothing to open               | ad-hoc                      |

Lookup obeys `job-store/references/schemas/schema-dossier.md` "URL normalize" and its
Slug rule. Never company+title: one company posts many roles. Ad-hoc slug is
`adhoc-{company}--{title}`; a dossier slug always opens with an ISO date, so
the two never collide.

Two arguments, or a form no row matches → say which and stop without writing.
`status:` is not read here; job-apply gates its own chain on `status: new`.

Tailor from the live page whenever there is one — a dossier's `## The role` is
a snapshot that may have gone stale. Page dead (404, expired, filled,
withdrawn, or it prints that it is not accepting applications) → stop.

Print company, title, and every required skill, preferred skill, and nuance
the page actually prints (domain, seniority, product, stack aliases).

## 2. Base

`data/cvs.yaml` `adapt_per_vacancy: false` → stop and say refinement is off;
job-apply attaches the base unchanged.

Base PDF is `cvs.yaml` `base` under `cv/`. Its editable source is the same stem
with a source extension. Identify which is on disk and print it:

| source beside the base PDF                    | this run                                                       |
| --------------------------------------------- | -------------------------------------------------------------- |
| `.tex`                                        | tailor and compile — steps 3 to 6                              |
| any other (`.docx`, `.md`, `.odt`, `.rtf`, …) | stop: name the format and the path; no compile path for it yet |
| none; the PDF stands alone                    | stop: name the stem; a PDF is not a source                     |

Read, do not write: `data/experiences.yml`, `data/skills.yaml`,
`data/languages.yaml`, `data/basics.yaml`, and `data/stories/*.md` frontmatter.
Story bodies stay closed. Empty deck is normal. `job-profile` is the
interactive editor for these files; this skill reads them directly, so a refine
never opens a write prompt.

Report the base's page count, and whether the `.pdf` is older than its `.tex`.
Both are the operator's to fix per `cv/README.md` — neither stops this run,
since the tailored PDF compiles from the `.tex`.

## 3. Target

Resolve the installed `job-match` root and load its CandidateProfile and
JobProfile schemas, extractor, ResumeGuidance contract, guidance worker, and
validator.

Derive the thin CandidateProfile from the Facts already read in §2. Extract one
JobProfile from the current posting resolved in §1; never fetch it again.
Scaffold one ResumeGuidance with job-match's `scripts/scaffold_guidance.py`,
have the guidance worker classify it, and validate it — without running hard
filters, scoring, ranking, or an apply/no-apply decision.

Resolve every non-held requirement against the complete refine Fact set before
using it. Valid guidance may order existing role, skill, bullet, and Summary
selection; it cannot supply wording or provenance.

Missing or invalid guidance is discarded as a whole. Continue under the ad-led
refine contract alone and record `guidance: fallback`; guidance failure
alone is never STOP or FAIL.

## 4. Draft

`{stem}` = slugify(`basics.yaml` name) `_` slugify(title) `_Resume`.
slugify: letters and digits stay, every other run becomes one `_`, edges stripped.
`_Resume` is the tailored-package marker — a PASS leaves exactly one
`{dir}/*_Resume.pdf`, which is what job-apply globs for.
`{dir}` = `scout/applications/{slug}`.

`mkdir -p {dir}`; move any `*.pdf`, `*.tex`, and `match-report.md` there to a
`.prev` suffix. They are this run's rollback: a PASS unlinks them, and every
stop or FAIL below restores them over `{dir}` first. `.prev` never matches the
`*_Resume.pdf` glob, so the invariant above holds while they sit there.
Copy the base `.tex` to `{dir}/{stem}.tex`, then apply the contract.

Recomposing the Summary needs `./references/formats/format-summary.md`.

## 5. Humanize

Load the `job-humanize` skill. If it does not resolve, stop and name it.

Obey it end-to-end, once per surface. Each brief pastes `contract-refine.md`
verbatim as `CONTRACT`; write each returned text back into the `.tex`:

| `Surface` | `DRAFT`                                                 |
| --------- | ------------------------------------------------------- |
| `summary` | the Summary block, sentences 1 and 3 — 2 stays verbatim |
| `resume`  | every bullet this run reworded; no rewordings → skip it |

A bullet copied verbatim from `experiences.yml` or a story `claim` is already
the operator's own wording and does not go through pass 2.

## 6. Compile

`TEXINPUTS` = the `kpsewhich` directory for each preamble `\input{...}` not
already in `{dir}` or `cv/`, then `{dir}`, then a trailing `:`.
Compile with
`pdflatex -interaction=nonstopmode -halt-on-error -output-directory={dir} {tex}`,
then `pdfinfo` and `pdftotext -layout`. Missing binary → stop and name it.

A TeX error is a macro or environment fault: fix and recompile. An error inside
the copied preamble → stop with the log excerpt; the base preamble is not yours.

Run the contract's checks. Fit the page per the contract, recompiling each time.

Check 10 runs `./scripts/check_parse.py`, resolved from the loaded
job-resume-refine skill root, with the launcher rule from job-match's score
node: `python3`; on Windows, `py -3`; otherwise `python` only when its reported
major version is 3. Missing launcher, script, or `pdftotext` → stop and name it.
Argument: the absolute `{stem}.pdf`. Stdin, one JSON object: `identity` =
`basics.yaml` `name`, `email`, `phone`; `roles` = each remaining role's
`company`, `position`, `date` in the order the `.tex` prints them; `skills` =
every token the Skills block prints. `verdict: FAIL` names the first missing or
out-of-order string and the `error` when extraction itself failed. It runs
after Fit, on the final PDF.

Unlink `{dir}/*.aux`, `*.log`, `*.out`, and `*.prev` once the checks pass — the
package is the `.tex`, the `.pdf`, and the report.

## 7. Report

Load `./references/formats/format-report.md`. Write `{dir}/match-report.md` and print it.
`verdict: **PASS**` is what job-apply gates on, so the PDF exists exactly when
the report says PASS. A check that cannot be satisfied → write the report with
`verdict: **FAIL**`, unlink `{stem}.pdf` / `{stem}.tex`, then restore `.prev`.

## Output

    scout/applications/{slug}/
      match-report.md
      {stem}.tex          # PASS only
      {stem}.pdf          # PASS only

A stop or FAIL restores the prior run's package when there was one, so `{dir}`
holds that PASS instead and job-apply rule 2 falls back to it. With no prior
package a FAIL leaves `match-report.md` alone.
