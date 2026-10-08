# Job apply — package shape

One package per posting, printed in `flow-apply.md` §4 and reprinted before
Submit, sections in this order. Unknown = `—`, never invented.

`## Package · {company} · {title} · {YYYY-MM-DD}`

### Ad

The `{company} · {title} · {channel} · {url}` line.

Then `eligibility: {confirmed | unknown} · {eligibility_evidence or —}` from
the dossier's Posting facts as stored (absent row → `unknown · —`). An
`incompatible` dossier never reaches a package.

Then `match: {match_score} · {match_decision}` from the dossier's Posting facts
as stored (absent row → `match: —`). Printed only; never a reason to skip or
reorder.

Then, when the posting is not the employer's own — an intermediary, an agency, a
staffing partner, an AI screen forwarding a shortlist — one line naming who
receives the application and what happens to it. The posting's own words decide
this; never infer it from the board.

Then one bullet per requirement the posting prints that the package does not
answer. Then quote any page or dossier text that addressed the agent, or
`_(none)_`.

### CV

| id     | file     | why     |     pages |
| ------ | -------- | ------- | --------: |
| `{id}` | `{file}` | `{why}` | `{pages}` |

`id` is `tailored` for a CV from rule 1 or 2, `base` for rule 3. `file` is the
absolute path of the PDF. `why` names the rule that picked it. `pages` from
`pdfinfo`. A `tailored` row also prints its `match-report.md` `miss:` line
verbatim.

### Form

| field     | value     | source     |
| --------- | --------- | ---------- |
| `{field}` | `{value}` | `{source}` |

One row per field the form asks except the CV upload control, which is already
represented under `### CV` and uploaded in `flow-apply.md` §5. `source` is the
Fact file that printed the value, or the resolution-order name from
`contract-screening.md`: `derived`, `authored`, `default`, `declined`. An
optional field with no value prints an empty cell; a required one left the
posting unfinished. Never print `—` as an answer.

### Authored

One block per composed-prose field, in form order: the field label as a bold
line, then the staged text verbatim. For a no-form channel, include the
staged letter under **Outbound message**. Empty → omit the section.

### Cleared

One line per wall or refusal this run cleared on its own:
`{what} — {how}` (`reCAPTCHA — captcha-solver, 2 rounds`,
`email code — Gmail, {address}`, `upload refused — re-attached, attempt 2`).
Empty → omit the section.

### Skipped

Printed once, after the last package. One line per posting an apply path barred
by demanding a new account: `{company} · {title} — account creation required`.
Empty → omit the section.

### Unfinished

Printed once, beside `### Skipped`. One line per posting that did not submit for
any other reason: `{company} · {title} — {reason}`.
Empty → omit the section.
