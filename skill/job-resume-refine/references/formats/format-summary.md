# Summary — shape

The base's opening prose block: the passage between `\begin{document}` and
the first role, whatever the base calls it. No such block → nothing to
recompose, and the rest of the page is unaffected.

When the base has a Summary, it remains exactly three sentences:

| #   | job                                                                                                           | drawn from                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | name the ad-led discipline and truthful duration, using a supported exact posting term or acronym when useful | roles that demonstrate it; years via `job-match/scripts/years.py`                |
| 2   | keep the standing angle that makes sentence 1 credible                                                        | the base's own Summary block, byte-for-byte                                      |
| 3   | give one recent proof the ad would care about, with a supported exact term when useful                        | the matching `claim` or `summary[]` clause, or a company-less story's named work |

Sentence 1 names a discipline the roles demonstrate. Sentence 3 names the
work and its company when the source has one; a company-less story names what
was built and for whom. Sentence 2 never moves between postings. A required or
preferred posting term appears only when a Fact supports it. Do not turn the
Summary into a stack list, stuff exact terms, or add hidden coverage; stack
names normally belong in Skills or a role-specific Technologies line.

Humanization is limited to sentences 1 and 3. Preserve every exact posting
term or acronym selected for coverage, every claim, and the three-sentence
shape. The raw role and bullet source is never rewritten by this format.

## The block, rendered

Keep the LaTeX shape the base already carries. The three slots are the table
above; wording comes from this profile's Facts and the current posting.

```latex
\vspace{-6pt}
\section{Summary}
\begin{itemize}[leftmargin=0.15in, label={}]
  \small\item{
    <sentence 1: supported ad-led discipline and truthful duration>
    <sentence 2: the base's standing angle, verbatim>
    <sentence 3: one recent supported proof, naming work and company, or what
    was built and for whom>
  }
\end{itemize}
```

Do not alter the surrounding preamble, layout commands, headings, role fields,
education, or raw bullet bytes to make Summary prose fit. The refinement
contract defines the fit order.

## Not a summary

A quoted phrase below is the failure, not a paraphrase of one.

- `I build product front-ends in React, Next.js and TypeScript` — the ad's
  stack read back without evidence or a work proof.
- `Passionate, results-driven engineer` — adjectives no Fact prints.
- `It worked`, `the client was happy`, `shipped to production` — not outcomes.
- `I am confident that`, `I believe I could`, `maybe` — hedges.
- `{n}+ years` above what `job-match/scripts/years.py` returns — years round
  down.
- A process count — PRs, lines of code, commits, files touched.
