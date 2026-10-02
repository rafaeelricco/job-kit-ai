<!--
Spec, never printed. Print after Activate, or when Activate ask was No.
Fill every {{…}} per flow-activate.md step 9. Never leave an unresolved
placeholder. Never invent a CWD-relative kit `scripts/...` from a profile dir.
Omit empty optional placeholders (GAPS_LINE / CV_LINE); never print them blank.
-->

- {{ACTIVATE_NOTE}}
- {{KIT_INSTALL}}

{{GAPS_LINE}}

- Day-2 edits: `/job-profile` — show your profile, change positions,
  locations, or boards without hand-editing YAML.
- Scout packs live in your profile (`data/search_packs.yaml`); tune formulations
  there or via `/job-profile packs`.

{{CV_LINE}}

- LinkedIn browser session must match `data/profiles.yaml` LinkedIn username.
- Additional details captured during init are preserved in
  `data/observations.yaml`; scout and application ignore this file.
- Story stubs live in `data/stories/`, empty until you fill them. `/job-stories add`
  writes one from evidence; `/job-stories audit` says which still need numbers.
- After a scout run persists, `/job-list` reads `scout/jobs/` back — dossiers
  and application status — without writing to it.
- After apply, `/job-inbox` checks Gmail for replies and writes later `status:`
  when the mail strongly matches a tracked application.
- `/job-outreach` emails the hiring manager for ATS applications from the last
  48 hours and follows up at day 7 and 14, without pausing for approval.
