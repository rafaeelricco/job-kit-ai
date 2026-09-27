# Summary — shape

The base's opening prose block: the passage between `\begin{document}` and the
first role, whatever the base calls it. No such block → nothing to recompose,
and the rest of the page is unaffected. Check 9 does not apply.

Three sentences, each with a job:

| #   | job                                               | drawn from                                                 |
| --- | ------------------------------------------------- | ---------------------------------------------------------- |
| 1   | the discipline the ad leads with, and how long    | roles that show it; years via `job-match/scripts/years.py` |
| 2   | the standing angle that makes sentence 1 credible | the base's own block, reusable verbatim                    |
| 3   | one recent proof the ad would care about          | the `claim` or `summary[]` clause whose work the ad raises |

Sentence 1 names a discipline the roles demonstrate. Sentence 3 names the work,
and its `{company}` when the source has one — a story with an empty `company`
names what was built and for whom. Sentence 2 does not move between ads.

Stack names belong in Skills, not in this block. Recruiter altitude is in
`./references/contracts/contract-refine.md`.

## The block, rendered

The LaTeX shape the base already carries; the three slots are the table
above, not sample prose — the wording comes from this profile's Facts.

```latex
\vspace{-6pt}
\section{Summary}
\begin{itemize}[leftmargin=0.15in, label={}]
  \small\item{
    <sentence 1: the discipline the ad leads with, and how long>
    <sentence 2: the base's standing angle, verbatim>
    <sentence 3: one recent proof the ad would care about, naming the work
    and its company, or what was built and for whom>
  }
\end{itemize}
```

## Not a summary

A quoted phrase below is the failure, not a paraphrase of one.

- `I build product front-ends in React, Next.js and TypeScript` — the ad's stack
  read back.
- `Passionate, results-driven engineer` — adjectives no Fact prints.
- `It worked`, `the client was happy`, `shipped to production` — not outcomes.
- `I am confident that`, `I believe I could`, `maybe` — hedges.
- `{n}+ years` above what `job-match/scripts/years.py` returns — years round down.
- A process count — PRs, lines of code, commits, files touched.
