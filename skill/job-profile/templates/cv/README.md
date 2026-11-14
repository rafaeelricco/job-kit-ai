# cv/

Place the compiled resume PDF here for applications:

- One PDF, named by `../data/cvs.yaml` `base`. It is what job-apply carries
  whenever no tailored PDF is available.
- `../data/cvs.yaml` absent, or `base` empty → the name must be
  `en-us-resume.pdf` (must open as PDF).

For Apply, rule 0 in `job-apply/references/flows/flow-apply.md` §3 has first
priority; otherwise the CV follows rules 1–3 in
`job-apply/references/contracts/contract-application-inputs.md` §2.

Never attach a `.tex` source. job-apply does not typeset. A tailored PDF comes
from `job-resume-refine` (chained in job-apply's CV step, or a prior standalone
`/job-resume-refine` PASS under `scout/applications/{slug}/`).

`/job-resume-refine` reads a LaTeX base from this folder to compile a tailored
PDF into `scout/applications/{slug}/`. The base is the `base` stem with `.tex`.
job-resume-refine copies that file whole and tailors it from profile Facts; it
never authors a new base. `cvs.yaml` still names only the PDF.
