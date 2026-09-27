# Intake

Refer to intake stages by name. Stages run in order;
every stage before **Approve** is read-only.
Batch only independent enums (Route modes; on the create path, Activate ask +
Source mode together). Dependent branches stay sequential. Enumerables:
options, most-likely first, labelled **(Recommended)**, free-text escape.
Never treat silence as an answer. Invent matrix + Hard refuses: `./references/flows/flow-fill.md` /
`../../SKILL.md`.

## Existing Profile root (read-only pre-discovery)

Before offering the Route outcomes, read the machine pointer once. Nothing is
registered here.

1. Resolve `HOST_HOME` / `HOST_DEFAULT` / `JOB_KIT_CONFIG` per `./references/flows/flow-activate.md`
   steps 3-4 (read-only; do not write pointers here).
2. Read the one line of `$HOST_HOME/.config/profile-root` when readable. Absent or
   unreadable (sandbox `Operation not permitted`) → no pointer; continue.
   Line resolves to a directory passing the two-file probe → offer that path as the
   **register existing** candidate, labelled already-active (pointer wins over
   path convention).
3. Else if `JOB_KIT_CONFIG` passes the two-file probe, treat it as the
   already-active candidate (recommended).
4. Pointer line resolves but fails the probe → say the pointer is **stale** and
   name it. Do not offer it as a register-existing candidate; carry the fact into
   the Activate ask, so the operator knows Yes replaces a stale pointer.

The discovered path is a recommendation, never a selection. No pointer file is
written before SKILL step 4. Do not sweep the filesystem — pointer + default
probes only.

## Route

Two outcomes; offer both.

- **Register existing**: directory holding both `data/candidate.yaml` and
  `data/job_search.yaml` (ignore any path under a `templates/` directory). Look
  where the operator points and where the session already is. Choosing this
  **ends intake** — no Folder, Source, Identity, or Approve; no emit; no fill.
  Then run **Activate ask** (below) with that path as `<target>`, then SKILL step 4.
- **Create new** → continue to Folder.

## Folder (create only)

Absolute `<target>` for the profile tree.

- **Default (Recommended):** `JOB_KIT_CONFIG` from pre-discovery. Single-profile layout:
  `data/` and `cv/` live directly under that path.
- Operator may override with another absolute path (migration / advanced).
- `<target>` must be absolute and must not exist or be an empty directory. Test
  before offering — never offer a path this law would refuse. Else STOP.
- Do not treat the directory basename as display name (identity comes later).

After `<target>` is accepted (create path): ask **Activate** and **Source
mode** in the same turn (below). Both answers are stored; Activate's answer is
consumed at SKILL step 4 after emit/fill.

## Activate ask (create + register-existing)

Once absolute `<target>` is known, ask whether to make it the machine Profile
root (so scout/apply can resolve it). Enum; **Yes (Recommended)** first. Silence
is not yes. Create path: ask together with Source mode in one turn (below).
Register-existing: this is the only remaining question — ask it alone.
Pointer / dual-home / pure-convention mechanics: `./references/flows/flow-activate.md` only.
Describe Activate as making `<target>` the Profile root skills resolve: by path
convention at host-default `~/.config/job-kit` (a pointer only when a valid XDG
profile would otherwise outrank it), through pointer files anywhere else. Its
session env export never reaches Aside.

Example prompt:

> Set `<target>` as this machine’s active Profile root so scout/apply resolve
> your facts? **Yes (Recommended)** / **No**. Silence is not Yes.

- **Yes (Recommended)** → SKILL step 4 runs `./references/flows/flow-activate.md` end-to-end.
- **No** → step 4 skips Activate **only** when `<target>` is **not** a path that
  skills probe by convention without a pointer. If `<target>` equals
  `JOB_KIT_CONFIG` (or canonical-equals `HOST_DEFAULT`), **No is not allowed**:
  presence of the two probe files would make the profile active immediately.
  Re-offer: **Yes (Recommended)**, or pick a different absolute non-default
  `<target>` and re-run Activate ask. Never emit under `JOB_KIT_CONFIG` after
  an Activate refusal.
  If pre-discovery found a **stale** pointer, say Yes would replace it (name the path).

## Source (create only)

One stage. Accept mode and path payload in the **same turn** when possible.

Modes: **file path(s)** (Recommended) | **paste** | **scaffold-only**.

- **path(s):** absolute path(s) to CV / LinkedIn export PDF / notes. Multi-file
  OK (e.g. CV + preferences.md). Unreadable or missing → STOP (do not emit);
  re-ask with:
  > Need a source of truth (file path and/or paste). Hard refuses bind — I will not invent facts.
  > Reply with path(s) or paste, then we continue.
- **paste:** the following user message is the SoT buffer. Chat memory alone is
  not SoT.
- **scaffold-only:** continue without a source of truth, ask the complete
  questionnaire directly, then emit the answered profile. If every field is
  skipped, state shells-only. Offer it; select only on the operator's explicit
  intent.

## Identity (create only)

Emit tokens: `display_name`, `email`, `linkedin_username`, `github_username`.

### When Source is path or paste

1. Full-ingest the SoT into a session **SoT buffer** (paths: read each file once
   here; paste: the paste body is the buffer). Record a **Source key** (sorted
   absolute path(s), or a paste fingerprint). Build an identity **draft** only
   from the buffer (LinkedIn URL → username without `@`). Extract only what is
   printed (Hard refuses + invent matrix bind).
2. Present the draft as proposals. The Profile questionnaire must still show
   every identity field and require confirm, edit, or skip.
3. Required before Approve: `display_name`, `linkedin_username` (no `@`).
   `email` and `github_username` are optional but still require an explicit
   value or skip (`""`).
4. Operator answers overwrite the draft for those fields.

### When Source is scaffold-only

No extract. Ask required fields (`display_name`, `linkedin_username`); offer
optional email and GitHub. Recommend only when grounded
(e.g. name the operator just typed — not prior-session memory).

## Profile questionnaire (create and scaffold-only)

Read `./references/formats/format-questionnaire.md`. Collect every user-owned field.
Register-existing skips this stage.

## Approve (create only) — the plan gate

Enter the harness plan workflow when one exists; otherwise present the same
plan in chat per `plan-format`. Plan what will be written, not what was asked:

- `<target>`, activation choice, source mode
- the emit tree, one line per file
- per data file, every value fill will write and every explicit skip —
  including pack choices, story stubs, observations,
  `adapt_per_vacancy`, and `base`
- Gaps the fill report will carry; CV source → destination; LaTeX base
  copy when adapt is yes

STOP and wait for an explicit yes. Silence, a question, or edits are not a
yes. Edits reopen only the affected questionnaire fields, then re-present the
plan. On yes → emit-tree, then fill. **No write before this yes.**
