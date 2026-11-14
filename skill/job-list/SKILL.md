---
name: job-list
description: "Compatibility alias for listing saved job dossiers through /job-match list."
argument-hint: "[all | status-board | <dossier>]"
disable-model-invocation: true
---

# Job list alias

Load `job-match` in `list` mode, followed by the original `/job-list` argument
suffix unchanged and in the same order. Do not pass the literal `/job-list`
command token. Do not score, re-score, refresh postings, or write to dossiers.
The `job-match` list route uses the shared read-only profile-root and store
setup, then follows its list flow.

`./references/flows/flow-job-list.md` is a stub kept for older installers; it
only points to the job-match list flow, so do not load it.
