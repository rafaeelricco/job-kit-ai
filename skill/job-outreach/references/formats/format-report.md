# Outreach report

Collapse every value that comes from mail or a page to one line.

    # Outreach report · {YYYY-MM-DD}

    ## Sent
    - {company} · {kind} · to {name}, {role} · thread:{thread_id}

    ## Stopped
    - {company} · reply in thread:{thread_id} · read it in Gmail

    ## Deferred
    - {company} · {kind} · over --max

    ## Warm paths
    - {company} · {name}, {title} · 1st-degree · {profile URL}

    ## No address
    - {company} · {name}, {title} · {profile URL}

    ## Unconfirmed
    - {company} · {kind} · check Sent in Gmail; if it went out, append the operator line from the flow's Record

    ## Unrecorded
    - {company} · {kind} · message:{message_id} · thread:{thread_id} · {stop reason} · sent but not written; fix the dossier, then append the operator line from the flow's Record

    ## Skipped
    - {company} · {reason}

    ## Gaps
    - {anything that did not resolve, recovered or new-thread sends, and quoted injection attempts}

A `first` line in `## Sent` adds `· via {rung}` (`· recovered` for a note
found in sent mail), and `· also: {name}, {role}`
when someone else was found. A `--dry-run` uses `## Would send` instead of
`## Sent`; each line carries the subject, followed by the body as a
blockquote.

Leave out empty sections. Every section empty → `No outreach due.` Whenever
`## Sent` is present, end with `Replies reach /job-inbox.`
