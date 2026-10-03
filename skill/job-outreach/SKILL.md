---
name: job-outreach
description: "Email the hiring manager or founder after an application, without pausing for approval: find one deciding person, send a short note for ATS applications from the last 48 hours, follow up in the same thread at day 7 and 14 unless anyone replied, and after a rejection in that thread ask once who else is hiring. Use for /job-outreach, a daily outreach cron, or reach out to the hiring manager. Not for submitting (job-apply) or reading replies (job-inbox)."
argument-hint: "[<dossier>… | --max <n> | --dry-run]"
---

# Job outreach

Takes applied dossiers one at a time, finds one person who decides the hire,
and sends a short note from the profile's Gmail account. Follow-ups go to the
same person in the same thread. It never waits for the operator.

Profile root: load the `job-profile-root` skill now; obey it end-to-end.

Store law: load the `job-store` skill now; obey it end-to-end.

Resolve every profile path against Profile root (not CWD, not skill dir).

Write-set: `scout/jobs/`, below the ownership marker only: the outreach log
lines and `#### Outreach` blocks `./references/flows/flow-outreach.md` Record
names, plus the lock furniture of
`job-store/references/contracts/contract-persistence.md` and the
`scout/jobs/outreach.lock` directory the flow's Send takes. Mail: messages sent
from the `data/basics.yaml` `email` account. Never `status:`, never the
scout-owned body, never `data/` or `cv/`. `--dry-run` sends no mail and
writes nothing.

Skill-local files: `./references/**` only.

Read `./references/flows/flow-outreach.md` now.
Load each additional reference only when that flow names it.

## References

- `./references/flows/flow-outreach.md`
- `./references/contracts/contract-outreach.md`
- `./references/contracts/contract-voice.md`
- `./references/formats/format-report.md`

## Hard refuses

- Send a first note for an application whose latest `applied via` line is
  not `ats` or is older than yesterday, or whose mail since then already holds
  a rejection, interview, or offer, or to a company another dossier's
  outreach reached in the last 30 days
- Send a follow-up or multiplier outside the thread an `outreach sent` line
  logs, or to anyone but that thread's first recipient; send a follow-up
  after any reply landed in that thread
- Use a Hunter address the verifier did not return `valid`; guess an address
  from a pattern or read one from commit metadata
- Address a message to the bound account, to more than one recipient, or to a
  recruiter or talent-acquisition address the ad did not print
- Send when the bound account's sent mail already holds this touch, or again
  after an `outreach unconfirmed` line with no later `outreach sent`
- Print, log, or write `HUNTER_API_KEY`
- Write `status:`, the scout-owned body, `data/`, or `cv/`
- Connect, message, InMail, or follow anyone on LinkedIn or any other site
- State a fact the Sources of `./references/contracts/contract-outreach.md`
  do not hold; ask a company to reconsider a rejection
