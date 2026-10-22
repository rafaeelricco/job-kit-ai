# Job store — apply-eligible

The one queue predicate. job-prep, job-apply, the prep digest, and the
dashboard implement this file; none adds a clause of its own. Reader law is
`./flow-read.md`; identity is `../schemas/schema-dossier.md` "URL normalize".

A dossier is apply-eligible when every clause holds, first failure named:

| #   | Clause                                                                                                                                                                                                                                                                                                                                      | Printed line on failure                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Frontmatter `status:` is `new`                                                                                                                                                                                                                                                                                                              | `Already {status} per scout/jobs/{filename}`                     |
| 2   | Not dead-by-log (`./flow-read.md` "A dead job never says dead in frontmatter")                                                                                                                                                                                                                                                              | `Posting dead per scout/jobs/{filename}`                         |
| 3   | No top-level `submit unconfirmed` line from `job-apply` with no later `applied via` line (pending)                                                                                                                                                                                                                                          | `Unconfirmed submit per scout/jobs/{filename}`                   |
| 4   | No other readable dossier whose stored `url` normalizes equal (same-URL twin)                                                                                                                                                                                                                                                               | `Duplicate url: scout/jobs/{filename} and scout/jobs/{other}`    |
| 5   | No other readable dossier with a different normalized `url` and the same `company` and `title` slug (schema-dossier "Filename" slug rule on the frontmatter values) whose `status:` is `applied`, `interview`, or `offer`, or pending per clause 3, or `new` and not dead-by-log                                                            | `Possible duplicate of scout/jobs/{other}`                       |
| 6   | Posting facts `eligibility` is not `incompatible` (`unknown` passes)                                                                                                                                                                                                                                                                        | `Incompatible per scout/jobs/{filename}: {eligibility_evidence}` |
| 7   | Posting facts `pay_usd_year` is not below the pay floor: run `job-store/scripts/pay.py` (launcher as `job-store/references/schemas/schema-dossier.md` "URL normalize") with `job_search.yaml` `salary_expectations.min` and this row's `salary`; a dossier with no `pay_usd_year` row uses that run's value. `—` pay or an empty min passes | `Pay below min per scout/jobs/{filename}: {pay_usd_year}`        |

Clause 5 is the only company+title comparison in the kit; identity stays the
normalized `url`. A caller may state a retry exception for clause 3 or a
proceed exception for clause 5; clauses 1, 2, 4, 6, and 7 have none. `unknown`
eligibility is printed, never a drop: the consumer names it in its package.
