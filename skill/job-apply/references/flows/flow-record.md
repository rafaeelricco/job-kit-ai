# Record confirmed application

This phase is the confirmed-submission row of `SKILL.md` Writes: it writes
only the dossier store.

Before writing, obey `job-store/references/schemas/schema-dossier.md` and
`job-store/references/contracts/contract-persistence.md`. Do not reproduce or replace those mechanics.
Normalize identity with `job-store/references/schemas/schema-dossier.md` "URL normalize".

## Write scope and lifecycle

On an existing dossier, touch only frontmatter `status:` and new content appended below
`<!-- scout never writes below this line -->`; never rewrite the scout-owned body or
existing log lines. Re-scan by normalized URL under the persistence lock before
choosing update or create.

| Existing dossier status                                                              | Result after confirmed application |
| ------------------------------------------------------------------------------------ | ---------------------------------- |
| `new`                                                                                | `applied`                          |
| `applied`                                                                            | unchanged                          |
| any other existing status, including `interview`, `offer`, `rejected`, and `dropped` | unchanged                          |
| no dossier                                                                           | create with `status: applied`      |

Always append the application log and record. A released non-`new` duplicate keeps its
status and uses the duplicate log line below. Never rewind a lifecycle state.

## Identity and write preconditions

Store identity is normalized URL only. Use the URL opened in the apply run or a URL
printed in the paste. If the ad line showed `—`, ask once:

`Source URL? Store identity is URL-only; I cannot record without one.`

Never invent or store `—` as `url:`. In a later session also ask for any missing company,
title, channel, and submission date (`YYYY-MM-DD`). Do not use the recording date as an
unstated submission date. Channel `—` must be resolved from the operator; never infer it.

A dossier matched on company and title only, whose URL does not re-match, is not
updated. Re-scan under the URL lock and create a new URL identity when no match
exists.

## Same-session record

The application heading is:

`#### Application {YYYY-MM-DD} · {channel}`

Append the ad line and only the final fully reprinted package, the one live at
the Submit click. A section that snapshot omitted is omitted here too. Never
append an earlier preview or combine deltas. Do not re-derive, summarize, or
invent content. Keep `declined` rows as `declined`.

The log line is:

`- {YYYY-MM-DD} · applied via {channel} — job-apply`

A released non-`new` duplicate uses:

`- {YYYY-MM-DD} · applied via {channel} · was {status} — job-apply`

For a new dossier, use the schema's nine frontmatter keys, set `first_seen` and
`last_seen` to today, use the normalized URL, `channel` from the ad line, `score: —`, and
`bucket: unbucketed`. Its body is exactly:

```markdown
# {company} — {title}

<!-- scout never writes below this line -->

- {today} · dossier opened by application, no scout run — job-apply
- {YYYY-MM-DD} · applied via {channel} — job-apply

#### Application {YYYY-MM-DD} · {channel}

{same-session record or later-session placeholder}
```

Do not fabricate Verdict, Posting facts, The role, or Provenance, and add no
frontmatter key beyond the nine. Where the operator found the posting is not
recorded.

## Later-session record

When the earlier ad line and preview are not in context, never reconstruct them from
the posting or memory. Re-identify URL, company, title, channel, and the actual
submission date before any write. Re-scan by URL, then follow the same schema update-or-
create path.

Append the application heading using the submission date and exactly one line:

`> record not available (confirmed in a later session)`

No section headings. Existing status follows the lifecycle table.

## Persistence encoding

Obey the append law in `job-store/references/schemas/schema-dossier.md`. Demote each `###`
heading to `#####` under the `####` application heading and blockquote every
non-heading line, table rows included. Never record passwords, credentials, one-time
codes, demographic/EEO answers, or any value the run did not print.

## Close

After the schema-compliant write and lock release, print the dossier filename, log line,
and resulting `status:`, then return to the queue. The queue's terminal step in
`flow-apply.md` owns the inbox leg, not this Close — a posting that did not
submit after an earlier one recorded never reaches here.
