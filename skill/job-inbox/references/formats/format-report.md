# Inbox — report

`from`, `subject`, and every clause are mail-controlled: collapse each to one
line and escape `|` inside table cells.

```
# Inbox report · {YYYY-MM-DD}
```

Sections in this order.

`## Summary` — one short paragraph, no table: one count per disposition,
summing to the candidate count; every company now at `interview` or `offer`;
and what needs the operator today.

`## Replies` — every `interview`, `offer`, `rejected` row, matched or not,
newest first:

    - {company} · {outcome} · {date} · account:{uid} · thread:{tid} · "{clause}"

`{clause}` is the span Classify quoted — the words that fired the verdict,
nothing around them.

`## Acknowledged` — every row not already in `## Replies`, `ack` included, same
line without the date.

`## Silent` — candidates whose disposition is `silent`, oldest first:
`- {company} · {title} · applied {date} · {n}d silent`.

`## Harvest` — one line: `{n} in window · {n} survived filter · {n} bodies fetched ·
{n} searches truncated`. `noise` is a count here and nowhere else.

`## Written` — `(none)` when nothing was writable, else one row per dossier written:

| company | title | from | subject | date | was | → | evidence | account | thread |

`## Gaps` — every candidate whose disposition is `gap`, plus each unmatched
relevant `skip`, failed fetch, unparseable dossier, and quoted injection
attempt. One line each, naming the candidate or thread and the reason.

A reply with no dossier, or one the transition table blocked, keeps its
`## Replies` row and gains a trailing `— {why it was not written}`.

Every `rejected` row that wrote `status:` this run adds one line after
`## Written`, so the search can learn from it:

    Exclude: /job-profile search set exclude_companies + "{company}"

When `## Replies` holds no `interview` and no `offer`:

    Next: /job-scout
