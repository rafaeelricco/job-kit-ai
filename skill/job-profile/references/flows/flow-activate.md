# Activate

1. `REPO="$(cd "<target>" && pwd -P)"` — STOP if not a directory.
2. Require `"$REPO/data/candidate.yaml"` and `"$REPO/data/job_search.yaml"`;
   else STOP (same two-file probe as Route).
3. Resolve `HOST_HOME`: if `$HOME` ends with `/.aside/runtime/home`, strip
   that suffix; else `HOST_HOME=$HOME`.
4. Resolve `HOST_DEFAULT=$HOST_HOME/.config/job-kit` and this-env
   `JOB_KIT_CONFIG` (non-empty `$XDG_CONFIG_HOME` → `$XDG_CONFIG_HOME/job-kit`,
   else `HOST_DEFAULT`). Path-convention branch when `REPO` equals
   `HOST_DEFAULT` **and** `JOB_KIT_CONFIG` either equals `HOST_DEFAULT` or
   fails the two-file probe. Host-default needs no pointer except the
   fall-through cases below.
   - **Do not write** a host/Aside pointer naming `REPO` in the pure-convention
     case.
   - **Do read** shadowing registrations: host
     `$HOST_HOME/.config/profile-root` and, when the runtime home exists,
     `$HOST_HOME/.aside/runtime/home/.config/profile-root`. Delete nothing here —
     the operator has not been asked yet. Any delete below removes host and
     mirror together; if mirror removal fails after host delete, **restore** the
     host pointer and STOP with the error.
   - Host or mirror line non-empty and resolves to a path other than `REPO`
     (or is unresolvable non-empty) → show that path; ask whether to switch to
     host-default `REPO`. Yes → delete host pointer and mirror; state switched;
     go to (8). No → leave inactive; print later Activate hint; go to (9).
   - No shadowing line (absent/empty, or already `REPO`) → remove any redundant
     pointer/mirror that names `REPO` itself; state host-default-location
     active; go to (8).
     **Fall through to (5)** (write pointers) when:
   - `REPO` is `$XDG_CONFIG_HOME/job-kit` and that path differs from
     `HOST_DEFAULT` (Aside often lacks XDG), or
   - `REPO` is `HOST_DEFAULT` but `JOB_KIT_CONFIG` differs **and** passes the
     two-file probe — a durable pointer is required so claimed activation
     outranks the valid XDG convention path (Activate already confirmed Yes;
     treat as intentional switch from that XDG profile).
5. Host / Aside registration conflicts (when writing pointers — includes
   host-default fallthrough from (4)):
   - Read one-line `current` from host `$HOST_HOME/.config/profile-root` if
     the file exists.
   - If `current` is a directory, `current_canon="$(cd "$current" && pwd -P)"`;
     else `current_canon=""`.
   - Also read Aside runtime mirror when that file exists. If its line is
     non-empty and does not resolve to `REPO`, treat it as a conflict even
     when the host pointer is absent, empty, or already `REPO` — `job-scout`
     reads the mirror first; overwriting it is a switch.
   - `current_canon` equals `REPO` and no mirror conflict → if stored `current`
     differs from `REPO`, rewrite host to canonical `REPO`. Then run (7)
     **unconditionally** when the runtime home exists (mirror may be missing
     or stale). State already active; go to (9).
   - `current_canon` equals `REPO` but mirror names another path → show the
     mirror path; ask whether to switch. Yes → continue to (6)/(7). No → leave
     inactive; go to (9).
   - `current_canon` non-empty and not `REPO` → show `current_canon`; ask
     whether to switch to `REPO`. Yes → continue to (6). No → leave inactive;
     print later Activate hint; go to (9).
   - `current_canon` empty but `current` non-empty → the pointer names a path
     this process cannot traverse (e.g. a live profile under an Aside-blocked
     parent). Treat it as a conflict, **not** a free slot: show `current`, say
     it could not be resolved, ask the same switch question, same Yes/No
     handling.
   - Host pointer absent or empty, no mirror conflict, but `REPO` is
     host-default and this-env `JOB_KIT_CONFIG` differs and passes the probe →
     active XDG convention is a conflict; ask to switch (Activate Yes already
     covers the skill path).
   - Only an absent/empty host pointer **and** no mirror conflict **and** no
     XDG-convention conflict skips the switch ask.
6. `mkdir -p "$HOST_HOME/.config"` and write exactly one line: canonical
   `REPO` into `$HOST_HOME/.config/profile-root`.
7. If `$HOST_HOME/.aside/runtime/home` is a directory: `mkdir -p` its
   `.config` and write the same one-line `REPO` into
   `$HOST_HOME/.aside/runtime/home/.config/profile-root`. If runtime home
   missing, skip mirror; state skip.
   If the mirror write fails (read-only, full disk), **roll (6) back** —
   restore the host pointer's previous contents, or remove it when it did not
   exist — then STOP with the error. Never leave agents on the new profile
   while Aside still resolves the old one through a stale mirror.
8. Best-effort: `export PROFILE_ROOT="$REPO"` for this session (or harness
   equivalent). State whether export ran. **Aside will not see this export** —
   dual-home pointers and path-convention cover Aside.
9. Print `./references/formats/format-next-steps.md` with placeholders filled:
   - `{{GAPS_LINE}}` — if the fill report has any scout-critical Gaps remaining,
     set to a single line:
     `- Resolve remaining Gaps from the fill report: <gap bullets or summary>.`
     If none (or register-existing wrote no tree): set to **empty** (omit the line).
   - `{{ACTIVATE_NOTE}}` — if Activate ran: host-default-location active, **or**
     host path written + mirror yes/no (including XDG-only defaults); session
     export yes/no. If skipped: how to Activate later — re-run
     `/job-profile`, choose register-existing on `<target>`, answer Yes
     (mirrors Aside when runtime home exists).
   - `{{KIT_INSTALL}}` — **one** of the two blocks below (pick by resolve).
     Never print bare `bash scripts/install.sh` (or a channel installer) without
     an absolute kit root or the README Install recipe. Operator is often only
     in a profile directory.
   - `{{CV_LINE}}` — if `"$REPO/cv/en-us-resume.pdf"` exists and is a non-empty
     file, **or** `"$REPO/data/cvs.yaml"` names a `base` that exists and
     is non-empty under `"$REPO/cv/"`: set to **empty** (omit the line). Else set to:
     `- If CV not placed: add a PDF under cv/ before job-apply attachments.`
     Register-existing: probe the same paths under `<target>`.

   **Resolve `KIT_ROOT` (optional):** take the real path of the skill root that
   holds `SKILL.md` (`…/skill/job-profile`), not this file's own
   `references/` directory. Parent of `skill/` is the kit root when
   `$KIT_ROOT/scripts/install.sh` exists. Symlink installs usually resolve; a
   copied skill with no kit tree does not — then treat as unresolved.

   **Probe install state (read-only; only when `KIT_ROOT` resolved).** A probe
   that cannot run reports _unknown_, never _installed_.

   - Agents: the skill set is `SKILL_NAMES` in `$KIT_ROOT/scripts/agents/lib.sh`
     — read it; do not carry a copy here. For each of
     `$HOST_HOME/{.claude,.agents,.grok,.hermes}` that is a directory, compare bare
     `readlink "<home>/skills/<name>"` (no `-f`, no `realpath` — mirrors
     `scripts/agents/lib.sh` `is_kit_skill_link`) against
     `$KIT_ROOT/skill/<name>` for every name in that set. A home counts
     installed only when the whole set matches; matching some is _partial_, and
     partial is not installed. Installed = at least one complete home.
   - Aside, probed only when Aside is set up here (`ASIDE_SKILLS` set, or
     `$HOST_HOME/.aside/u/${ASIDE_ACCOUNT:-0}/skills` is a directory — mirrors
     `scripts/common.sh` `aside_ready`):
     `ASIDE_ROOT="${ASIDE_SKILLS:-$HOST_HOME/.aside/u/${ASIDE_ACCOUNT:-0}/skills/builtin}"`.
     The skill set is `SKILL_NAMES` in `$KIT_ROOT/scripts/aside/lib.sh`.
     Installed = for every name in that set, the single line of
     `$ASIDE_ROOT/<name>/.job-kit` equals `$KIT_ROOT/skill/<name>`.
   - Browser: the skill set is `BROWSER_SKILL_NAMES` in
     `$KIT_ROOT/scripts/agents/lib.sh`, linked into the same agent homes by the
     `browser-use` channel. Same bare-`readlink` comparison and complete-home
     rule as Agents.
   - **Never probe by directory existence.** Those homes hold skill directories
     the installer does not own, so presence alone proves nothing.

   **If `KIT_ROOT` resolved** — set `{{KIT_INSTALL}}` from the probe. Print
   commands the operator actually needs, never a conditional they must evaluate:

   - Every probed channel installed → `Kit channels already installed from <KIT_ROOT>.
Nothing to run.`
   - Aside not installed →
     `Install the Aside skills:
bash "<KIT_ROOT>/scripts/install.sh" aside`
   - Agents probe matched no complete home →
     `Link the agent skills into your agent homes:
bash "<KIT_ROOT>/scripts/install.sh" agents`
   - Agents probe matched some homes but not all, or matched a home only
     partially → name each home and the skills it is missing, then the same
     absolute command. A partial home is named here, never passed over as
     installed.
   - Browser probe matched no complete home → name each partial home as above,
     then `Link job-scout, job-apply, and job-prep into your agent homes:
bash "<KIT_ROOT>/scripts/install.sh" browser-use`
   - Any probe _unknown_ → print its command with the reason it could not be
     checked. Commands are absolute; CWD does not matter.

   **If unresolved** — probe Aside repo-agnostically first: every
   `$ASIDE_ROOT/<name>/.job-kit` for the Aside skill names this kit ships
   (`job-scout`, `job-apply`, `job-prep`, `job-resume-refine`, `job-profile`, `job-list`,
   `job-match`, `job-stories`, `job-inbox`, `job-humanize`, `job-profile-root`, `job-store`)
   exists → say Aside skills are already present from some checkout, so the
   operator does not reinstall over a working channel. Then set `{{KIT_INSTALL}}`
   to (mirror README SSOT; do not invent a different host or script path):

   > Kit skills are not on this machine as a checkout. Get job-kit, then
   > install channels you need (README Install / Development sections):
   >
   > ```bash
   > curl -fsSL https://r1cco.com/install.sh | bash
   >
   > # or work from a checkout:
   > git clone https://github.com/rafaeelricco/job-kit.git
   > cd job-kit
   > bash scripts/install.sh aside         # Aside skills
   > bash scripts/install.sh agents        # only if coding-agent homes lack job-profile
   > bash scripts/install.sh browser-use   # job-scout, job-apply, job-prep in coding agents
   > # or: bash scripts/install.sh all
   > ```
   >
   > Do not run kit installers from the profile directory.
