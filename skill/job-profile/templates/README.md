# Profile

Canonical facts for **job-scout** (list-only scout; passes login gates to list)
and **job-apply** (queue → package → clear walls → submit → record),
read back by **job-list** (read-only). Later lifecycle status from mail is **job-inbox**.
Skills live in **job-kit**, not in this tree.

## Layout

| Folder          | What's in it                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/`         | Canonical YAML about you. Edit here first.                                                                                                                                |
| `data/stories/` | One markdown file per interview story; frontmatter is read by job-apply, job-stories, job-resume-refine, and job-resume-review, the body is not                           |
| `cv/`           | The base resume PDF plus its LaTeX source                                                                                                                                 |
| `scout/`        | Written by job-scout; `status:` and Application-log records by job-apply and job-inbox; read by job-list: `jobs/` per-job dossiers (`{first_seen}-{company}--{title}.md`) |

`data/` may mix `.yaml` and `.yml`. `data/stories/` holds markdown files with
YAML frontmatter.

## Register Profile root

`/job-profile` offers **Activate** at the end of the flow. Registration
runs only when the operator answers **Yes**. **No** leaves a data-only tree
(not allowed when the target is host-default / `JOB_KIT_CONFIG`, which would
auto-activate from the probe file alone).

To register manually, or to switch the active profile later, re-run
`/job-profile` against this path and answer **Activate: Yes**.

Host-default `~/.config/job-kit` is always skill-probed, and usually needs no
pointer. Activate does register it when a valid `$XDG_CONFIG_HOME/job-kit`
profile also exists: the pointer is what keeps host-default ahead of it, so do
not delete it, or this profile stops winning.

Any other location — including `$XDG_CONFIG_HOME/job-kit` when it differs —
always gets `~/.config/profile-root` plus the Aside runtime mirror when present. To
remove this profile tree and kit skills, run the kit uninstaller from the job-kit
directory: `bash scripts/uninstall.sh` (choose Profile or All; it prints a plan
and asks before deleting anything). Path-convention
roots stay active until the tree is deleted.

## Fill before a useful run

1. Run `/job-profile`; it asks every user-owned field, then plans every
   write for one approval. Source values and defaults require explicit
   confirmation, edits, or skips.
2. Review Gaps in the fill report; fix any empty fields scout needs.
3. The compiled CV PDF goes in `cv/`; name it in `data/cvs.yaml` `base` (set via
   `/job-profile cv set`). Set `adapt_per_vacancy` there too. With no `base`,
   job-apply attaches `cv/en-us-resume.pdf`.
4. Search packs live in this profile at `data/search_packs.yaml`; tune formulations
   there or via `/job-profile packs`.
   `*-boards` packs discover slugs each run from `site:` and the store.
5. Free-form details are stored in `data/observations.yaml`.
6. Story stubs are created empty under `data/stories/`; fill them with
   `/job-stories add`.

## Rules

- Facts are read from files, never recalled from chat memory.
- job-scout is list-only (never apply/message/connect). It may use an existing
  session; account creation, signup terms, passwords, and verification remain
  operator actions. job-apply queues postings, fills the form from Facts, prints
  the package it will record, then clears what the form puts in the path —
  terms, upload, a sign-in with an existing session or `Continue with Google`
  as your profile email, a code from Gmail, a captcha via `captcha-solver`,
  Submit — and records to `scout/jobs/` on submit success (or when you confirm
  you submitted outside it). It never waits for you: only a demand to create an
  account skips the posting; every other blocker no rule clears leaves it
  unfinished, and a rerun retries it.
  job-inbox reads Gmail for replies and writes
  `interview` / `offer` / `rejected` when evidence is strong.
