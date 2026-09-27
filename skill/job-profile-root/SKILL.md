---
name: job-profile-root
description: "Print the absolute job-kit Profile root path. Read-only."
---

# Job profile root

Print the absolute path before returning. STOP if none. Do not invent a path.

**Probe** (all must pass): dir exists, readable, has `data/candidate.yaml` and `data/job_search.yaml`. Unreadable (sandbox `Operation not permitted`, missing path) → fail that candidate; next step.

1. `$PROFILE_ROOT` if set and probe passes.
2. `$HOME/.config/profile-root` (one absolute path line); probe if non-empty.
3. **Aside dual-home pointer:** if `$HOME` is exactly or ends with `/.aside/runtime/home`, compute `HOST_HOME` (strip suffix, else `$HOST_HOME` env if absolute); read `$HOST_HOME/.config/profile-root`; probe when not already tried.
4. **Default config dirs** (probe each not already tried):
   - `JOB_KIT_CONFIG`: non-empty `$XDG_CONFIG_HOME` → `$XDG_CONFIG_HOME/job-kit`, else `$HOME/.config/job-kit`.
   - **Host-default fallback:** `$HOST_HOME/.config/job-kit` (`HOST_HOME` from step 3 if dual-home, else strip `/.aside/runtime/home` from `$HOME` or use `$HOME`). Probe when that path differs from `JOB_KIT_CONFIG`.
5. Walk session CWD upward until probe passes.
6. else STOP. Name each attempt (env, each pointer file + line, each default config path, walk start), then point at `job-profile` in a coding agent (**create new**, or **register existing** with Activate = Yes). Load `./references/formats/format-recover.md` on STOP or step 2–4 fail. Never scaffold a profile from here.

Return: `Profile root: {absolute path}`. Caller resolves its own `data/*` / `scout/` against that path.
