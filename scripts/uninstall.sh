#!/usr/bin/env bash
# Single job-kit uninstaller: interactive menu or target args.
# Compatible with macOS Bash 3.2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
# shellcheck source=common.sh
. "${REPO_ROOT}/scripts/common.sh"
JOB_KIT_HOME="${JOB_KIT_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}/job-kit}"
ASIDE_ACCOUNT_ID="${ASIDE_ACCOUNT:-0}"

# Ownership probe for cache purge (must match remote.sh KIT_OWNERSHIP_FILES intent).
# `scripts/uninstall.sh` is deliberately absent: this uninstaller ships it, so
# every cache installed before it exists lacks the file. Demanding it would make
# the new uninstaller refuse to purge exactly the installs it must clean up —
# remote.sh calls that same set KIT_LEGACY_OWNERSHIP_FILES. The four channel
# libraries under a real `skill/` directory already identify a job-kit tree.
KIT_OWNERSHIP_FILES="scripts/agents/install.sh scripts/agents/lib.sh
scripts/aside/install.sh scripts/aside/lib.sh
skill/job-profile/SKILL.md
skill/job-scout/SKILL.md"

DRY_RUN=0
# Space-separated target list for the current run_plan; used by browser-use plan
# and preflight to account for combined agents+browser-use apply order.
UNINSTALL_TARGETS=""

# strip_trailing_slashes PATH
# Prints PATH with trailing slashes removed (a lone "/" is kept).
strip_trailing_slashes() {
  local p="$1"
  while [ "${#p}" -gt 1 ] && [ "${p%/}" != "${p}" ]; do
    p="${p%/}"
  done
  printf '%s' "${p}"
}

JOB_KIT_HOME="$(strip_trailing_slashes "${JOB_KIT_HOME}")"

# Every path this script deletes is built from these, so each is required to be
# absolute and free of traversal before it can reach `rm -rf`. Relative to the
# caller's CWD they name whatever happens to sit there — `JOB_KIT_HOME=job-kit`
# purged a checkout in the working directory, `HOME=.` deleted `./.config/job-kit`.
case "${JOB_KIT_HOME}" in
  /*) ;;
  *) die "JOB_KIT_HOME must be an absolute path (got: ${JOB_KIT_HOME})" ;;
esac
case "${HOME}" in
  /*) ;;
  *) die "HOME must be an absolute path (got: ${HOME})" ;;
esac
case "${ASIDE_ACCOUNT_ID}" in
  */* | . | .. | "") die "ASIDE_ACCOUNT must be one path component, without separators or dot traversal (got: ${ASIDE_ACCOUNT_ID})" ;;
  *) ;;
esac

# resolve_host_home
# Inside Aside, HOME is <host>/.aside/runtime/home. Strip that suffix so host
# paths match install/activate.
resolve_host_home() {
  local suffix="/.aside/runtime/home"
  case "${HOME}" in
    *"${suffix}") printf '%s\n' "${HOME%${suffix}}" ;;
    *) printf '%s\n' "${HOME}" ;;
  esac
}

host_default_root() {
  printf '%s/.config/job-kit\n' "$(resolve_host_home)"
}

# job_kit_config — the XDG profile root, or the host default.
# A relative XDG_CONFIG_HOME is refused rather than resolved: this path is handed
# to `rm -rf`, and relative to the caller's CWD it names whatever happens to sit
# there — `XDG_CONFIG_HOME=.` turns `profile` into "delete ./job-kit".
job_kit_config() {
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    case "${XDG_CONFIG_HOME}" in
      /*) ;;
      *) die "XDG_CONFIG_HOME must be an absolute path (got: ${XDG_CONFIG_HOME}); unset it to use the host default" ;;
    esac
    printf '%s/job-kit\n' "${XDG_CONFIG_HOME}"
  else
    host_default_root
  fi
}

# browser_harness_state — the browser-use driver's state dir (may be absent).
# Same XDG rule job_kit_config applies, and for the same reason: this path is
# handed to `rm -rf`, and a relative XDG_CONFIG_HOME names whatever happens to
# sit under the caller's CWD. Refuse rather than resolve.
browser_harness_state() {
  if [ -n "${XDG_CONFIG_HOME:-}" ]; then
    case "${XDG_CONFIG_HOME}" in
      /*) ;;
      *) die "XDG_CONFIG_HOME must be an absolute path (got: ${XDG_CONFIG_HOME}); unset it to use the host default" ;;
    esac
    printf '%s/browser-harness\n' "${XDG_CONFIG_HOME}"
  else
    printf '%s/.config/browser-harness\n' "${HOME}"
  fi
}

# profile_pointer_files — host + Aside-mirror profile-root paths (may be absent).
profile_pointer_files() {
  local host_home
  host_home="$(resolve_host_home)"
  printf '%s\n' "${host_home}/.config/profile-root"
  printf '%s\n' "${host_home}/.aside/runtime/home/.config/profile-root"
}

# read_profile_pointer FILE — print absolute one-line content, or die on bad line.
# Empty/missing file → print nothing (not an error).
read_profile_pointer() {
  local file="$1" line
  [ -f "${file}" ] || return 0
  line="$(tr -d '\n' < "${file}")"
  [ -n "${line}" ] || return 0
  case "${line}" in
    /*) printf '%s\n' "${line}" ;;
    *) die "profile-root pointer ${file} must be an absolute path (got: ${line})" ;;
  esac
}

# profile_delete_candidates — convention roots ∪ absolute pointer targets.
# Does not filter on existence; callers filter. Order: config, host_default, pointers.
profile_delete_candidates() {
  local path file
  printf '%s\n' "$(job_kit_config)"
  printf '%s\n' "$(host_default_root)"
  while IFS= read -r file; do
    [ -n "${file}" ] || continue
    path="$(read_profile_pointer "${file}")" || exit 1
    [ -n "${path}" ] || continue
    printf '%s\n' "${path}"
  done <<EOF
$(profile_pointer_files)
EOF
}

# refuse_profile_path PATH — die when PATH overlaps the checkout or the kit cache.
# Equality alone is not enough. A checkout nested under the profile root — say
# `$XDG_CONFIG_HOME/job-kit/src/job-kit` — passes an equality test and is then
# handed to `rm -rf` with every uncommitted change in it, and each later target
# loses the libraries it sources from there. The other direction is refused too:
# a profile root under the checkout is the layout the README already rules out
# ("never enter this repo"), and deleting it shreds tracked files.
refuse_profile_path() {
  local path="$1" cache
  if paths_overlap "${path}" "${REPO_ROOT}"; then
    die "refusing to delete profile root overlapping the executing checkout: ${path} (checkout: ${REPO_ROOT})"
  fi
  cache="${JOB_KIT_HOME}"
  if [ -d "${JOB_KIT_HOME}" ]; then
    cache="$(cd "${JOB_KIT_HOME}" && pwd -P)" || cache="${JOB_KIT_HOME}"
  fi
  if paths_overlap "${path}" "${JOB_KIT_HOME}" || paths_overlap "${path}" "${cache}"; then
    die "refusing to delete profile root overlapping the kit cache: ${path} (cache: ${cache})"
  fi
}

# profile_probe_missing DIR — first required profile file DIR lacks, or empty.
# The profile probe activation runs before it writes a pointer, and every skill
# re-runs before it trusts one. An unreadable dir reports the same as a missing
# file: both mean this was not proven to be a profile.
profile_probe_missing() {
  local dir="$1" rel
  for rel in data/job_search.yaml; do
    if [ ! -f "${dir}/${rel}" ]; then
      printf '%s\n' "${rel}"
      return 0
    fi
  done
}

# paths_equal A B — same string or same physical directory.
paths_equal() {
  local a="$1" b="$2"
  [ "${a}" = "${b}" ] && return 0
  if [ -d "${a}" ] && [ -d "${b}" ]; then
    [ "$(cd "${a}" && pwd -P)" = "$(cd "${b}" && pwd -P)" ]
    return $?
  fi
  return 1
}

# resolve_physical PATH — PATH with its deepest existing ancestor resolved.
# `refuse_profile_path` runs before the existence test, so a candidate that is
# not there cannot be `cd`-ed into: resolve the part that does exist and keep the
# rest lexically, so both sides of an overlap test are comparable the way
# `paths_equal` compares two existing directories.
resolve_physical() {
  local head tail=""
  head="$(strip_trailing_slashes "$1")"
  while [ "${head}" != "/" ] && [ ! -d "${head}" ]; do
    tail="/$(basename "${head}")${tail}"
    head="$(dirname "${head}")"
  done
  if [ -d "${head}" ]; then
    # The fallback already handles an unsearchable directory; let it do so
    # quietly, or the shell's `cd` error lands on top of the refusal it precedes.
    head="$(cd "${head}" 2>/dev/null && pwd -P)" || head="${head}"
  fi
  case "${head}" in
    /) printf '%s\n' "${tail:-/}" ;;
    *) printf '%s%s\n' "${head}" "${tail}" ;;
  esac
}

# path_contains ANCESTOR DESCENDANT — 0 when DESCENDANT sits strictly under
# ANCESTOR. The `/` in the pattern carries the whole check: without it `/a/bc`
# reads as inside `/a/b`. A `/` ancestor becomes empty so the pattern stays `/*`.
path_contains() {
  local a b
  a="$(strip_trailing_slashes "$1")"
  b="$(strip_trailing_slashes "$2")"
  if [ "${a}" = "/" ]; then
    a=""
  fi
  case "${b}" in
    "${a}"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# paths_overlap A B — same physical path, or one physically contains the other.
paths_overlap() {
  local a b
  a="$(resolve_physical "$1")"
  b="$(resolve_physical "$2")"
  [ "${a}" = "${b}" ] && return 0
  path_contains "${a}" "${b}" && return 0
  path_contains "${b}" "${a}" && return 0
  return 1
}

usage() {
  cat <<'EOF'
Uninstall job-kit (one script for all components).

Usage: uninstall.sh                 # interactive menu (TTY required)
       uninstall.sh <target>…       # non-interactive (one or more targets)
       uninstall.sh -h|--help

Targets:
  aside     Aside skills (job-scout, job-apply, job-prep, job-resume-refine, job-profile, job-list, job-match, job-stories, job-inbox, job-humanize, job-profile-root, job-store)
  agents    Coding-agent skills (job-profile, job-list, job-match, job-stories, job-inbox, job-humanize, job-profile-root, job-store, job-resume-refine)
  browser-use  Browser skills (job-scout, job-apply, job-prep) in coding-agent homes, plus
               the browser-use driver: its skill, its CLI, its state directory.
               Never a browser app bundle
  profile   Delete profile root(s) + matching profile-root pointers
  cache     Remove kit checkout cache (JOB_KIT_HOME), kit-owned only
  all       aside + agents + browser-use + profile + cache

Options:
  --dry-run     Print the plan, run every guard, remove nothing
  -h, --help    Show this help

Every run prints a plan first. A plan holding profile or cache data requires
typing yes; anything re-installable takes [Y/n]. On a pipe, re-installable
targets apply after the plan and profile/cache refuse.

Profile path: $XDG_CONFIG_HOME/job-kit when set, otherwise $HOME/.config/job-kit,
and both when they differ.

Environment:
  JOB_KIT_HOME   Kit cache (default $XDG_DATA_HOME/job-kit or ~/.local/share/job-kit)
  ASIDE_SKILLS / ASIDE_ACCOUNT / CLAUDE_SKILLS
                 Same overrides as the channel installers
EOF
}

# uninstall_aside — remove kit-owned Aside skills via aside/lib.sh (subshell).
uninstall_aside() {
  local repo="${REPO_ROOT}"
  (
    # shellcheck source=aside/lib.sh
    . "${repo}/scripts/aside/lib.sh"
    local dest_root name dest
    dest_root="$(resolve_aside_skills_root)" || exit 1
    echo "== job-kit Aside uninstall for ${dest_root} =="
    unlink_legacy_skills "${dest_root}" "${repo}" || exit 1
    for name in ${SKILL_NAMES}; do
      dest="$(skill_dest "${dest_root}" "${name}")"
      unlink_skill "${dest}" "${repo}" "${name}"
    done
    remove_legacy_user_skills "${repo}" "${dest_root}" "${SKILL_NAMES}" || exit 1
    echo "Uninstall completed for ${dest_root}"
  )
}

# uninstall_agents — remove kit-owned agent skill links via agents/lib.sh (subshell).
uninstall_agents() {
  local repo="${REPO_ROOT}"
  (
    # shellcheck source=agents/lib.sh
    . "${repo}/scripts/agents/lib.sh"
    local override dest_root target parent label
    override="$(resolve_override_skills)" || exit 1

    echo "== job-kit agents uninstall =="

    if [ -n "${override}" ]; then
      echo "== override (${override}) =="
      uninstall_skills_from "${override}" "${repo}" "$(agents_names_for_root "${override}" "${repo}")" || exit 1
      echo "Uninstall completed for ${override}"
      exit 0
    fi

    for target in ${AGENT_TARGETS}; do
      parent="$(agent_parent_dir "${target}")"
      dest_root="$(agent_skills_root "${target}")"
      label="$(agent_label "${target}")"
      if [ ! -d "${parent}" ] && [ ! -d "${dest_root}" ]; then
        echo "${label}: nothing to uninstall (${dest_root})."
        continue
      fi
      echo "== ${label} (${dest_root}) =="
      uninstall_skills_from "${dest_root}" "${repo}" "$(agents_names_for_root "${dest_root}" "${repo}")" || exit 1
      if [ "${target}" = claude ]; then
        unlink_worker_agent || exit 1
      fi
    done

    remove_legacy_codex_skills_dir "${repo}" || exit 1
    echo "Uninstall completed"
  )
}

# uninstall_browser_use — remove kit-owned browser skill links, then the
# browser-use driver artifacts plan_rows_browser_use listed (subshell).
# Two different ownership stories in one target: the job-scout / job-apply links
# are kit-owned and go through unlink_skill's readlink predicate exactly as the
# agents channel does; the driver is browser-use's own installation, so only the
# three artifacts the plan named are touched — never a browser app bundle.
uninstall_browser_use() {
  local repo="${REPO_ROOT}" state
  state="$(browser_harness_state)"
  (
    # shellcheck source=agents/lib.sh
    . "${repo}/scripts/agents/lib.sh"
    local override dest_root target parent label name dest
    local cli_failed=0

    # Remove browser skills and dependencies unused by a remaining agents install.
    unlink_browser_skills_from() {
      local root="$1" n d agents_owned=0
      for n in ${BROWSER_SKILL_NAMES} ${BROWSER_LEGACY_SKILL_NAMES}; do
        d="$(skill_dest "${root}" "${n}")"
        unlink_skill "${d}" "${repo}" "${n}"
      done
      for n in job-stories job-inbox; do
        if is_kit_skill_link "$(skill_dest "${root}" "${n}")" "${repo}" "${n}"; then
          agents_owned=1
          break
        fi
      done
      for n in ${BROWSER_SHARED_DEPS}; do
        if [ "${agents_owned}" -eq 1 ]; then
          case " ${SKILL_NAMES} " in
            *" ${n} "*) continue ;;
          esac
        fi
        d="$(skill_dest "${root}" "${n}")"
        unlink_skill "${d}" "${repo}" "${n}"
      done
    }

    override="$(resolve_override_skills)" || exit 1

    echo "== job-kit browser-use uninstall =="

    if [ -n "${override}" ]; then
      # Kit links live only under the override. The driver may also live there
      # (`browser-use skill install --path`), and still under the default
      # homes from a prior --target install — both get cleaned.
      echo "== override (${override}) =="
      unlink_browser_skills_from "${override}" || exit 1
      echo "Uninstall completed for ${override}"
    else
      for target in ${AGENT_TARGETS}; do
        parent="$(agent_parent_dir "${target}")"
        dest_root="$(agent_skills_root "${target}")"
        label="$(agent_label "${target}")"
        if [ ! -d "${parent}" ] && [ ! -d "${dest_root}" ]; then
          echo "${label}: nothing to uninstall (${dest_root})."
          continue
        fi
        echo "== ${label} (${dest_root}) =="
        unlink_browser_skills_from "${dest_root}" || exit 1
      done
    fi

    # Driver artifacts are browser-use's own files, not kit-owned: remove only
    # what the plan listed, and never a browser.
    echo "== browser-use · driver (not kit-owned) =="
    if [ -n "${override}" ]; then
      dest="${override}/browser-use"
      if [ -e "${dest}" ] || [ -L "${dest}" ]; then
        rm -rf "${dest}" || {
          echo "error: failed to remove driver skill: ${dest}" >&2
          exit 1
        }
        echo "removed driver skill: ${dest}"
      else
        echo "skipped (missing): ${dest}"
      fi
    fi
    for target in ${AGENT_TARGETS}; do
      dest="$(agent_skills_root "${target}")/browser-use"
      if [ -n "${override}" ] && [ "${dest}" = "${override}/browser-use" ]; then
        continue
      fi
      if [ -e "${dest}" ] || [ -L "${dest}" ]; then
        rm -rf "${dest}" || {
          echo "error: failed to remove driver skill: ${dest}" >&2
          exit 1
        }
        echo "removed driver skill: ${dest}"
      else
        echo "skipped (missing): ${dest}"
      fi
    done
    if command -v browser-use >/dev/null 2>&1; then
      # The plan counted the CLI as a removal, so a miss here is a failure, not
      # a note: keep cleaning up the rest, then refuse to report success.
      if command -v uv >/dev/null 2>&1; then
        uv tool uninstall browser-use || {
          echo "error: uv tool uninstall browser-use failed; remove it yourself" >&2
          cli_failed=1
        }
      else
        echo "error: browser-use CLI left installed (uv not found): $(command -v browser-use)" >&2
        cli_failed=1
      fi
    fi
    if [ -d "${state}" ]; then
      rm -rf "${state}" || {
        echo "error: failed to remove driver state: ${state}" >&2
        exit 1
      }
      echo "removed driver state: ${state}"
    fi
    echo "Google Chrome left installed (uninstall it yourself if you want it gone)."
    [ "${cli_failed}" -eq 0 ] || exit 1
    echo "Uninstall completed"
  )
}

# clear_pointer_if_matches FILE PATH…
# Removes FILE when its one-line content equals any PATH (string or physical).
clear_pointer_if_matches() {
  local file="$1" line canon p
  shift
  [ -f "${file}" ] || return 0
  line="$(tr -d '\n' < "${file}")"
  [ -n "${line}" ] || {
    rm -f "${file}" || die "failed to remove pointer: ${file}"
    echo "removed empty pointer: ${file}"
    return 0
  }
  if [ -d "${line}" ]; then
    canon="$(cd "${line}" && pwd -P)"
  else
    canon=""
  fi
  for p in "$@"; do
    if [ "${line}" = "${p}" ]; then
      rm -f "${file}" || die "failed to remove pointer: ${file}"
      echo "removed pointer: ${file}"
      return 0
    fi
    if [ -n "${canon}" ] && [ -d "${p}" ] && [ "${canon}" = "$(cd "${p}" && pwd -P)" ]; then
      rm -f "${file}" || die "failed to remove pointer: ${file}"
      echo "removed pointer: ${file}"
      return 0
    fi
    # Dangling pointer: content named p but directory is already gone.
    if [ -n "${canon}" ] && [ "${canon}" = "${p}" ]; then
      rm -f "${file}" || die "failed to remove pointer: ${file}"
      echo "removed pointer: ${file}"
      return 0
    fi
  done
}

# validate_profile_inputs — prove XDG + pointer lines, and that a present pointer
# target is a profile, at this shell (not in $()).
# `die` inside a command substitution only kills the subshell; multi-target runs
# must refuse here before any earlier target is allowed to proceed.
validate_profile_inputs() {
  local file path missing root target
  job_kit_config >/dev/null
  host_default_root >/dev/null
  # A convention root is removable on its name alone — that is the contract, and
  # it keeps a half-written `~/.config/job-kit` removable. A *symlink* there is
  # not that name: it is an alias for a tree this kit never chose, and
  # `remove_profile` resolves it and hands the target to `rm -rf`. Prove the
  # target is a profile, or refuse rather than delete an unrelated directory.
  for root in "$(job_kit_config)" "$(host_default_root)"; do
    [ -L "${root}" ] || continue
    [ -d "${root}" ] || continue
    target="$(cd "${root}" && pwd -P)"
    missing="$(profile_probe_missing "${target}")"
    [ -z "${missing}" ] \
      || die "refusing to delete profile root ${root}: it is a symlink to ${target}
missing or unreadable: ${missing} (a symlinked root is only an alias; its target must be a profile)
delete ${target} yourself, or remove the link"
  done
  while IFS= read -r file; do
    [ -n "${file}" ] || continue
    read_profile_pointer "${file}" >/dev/null
    path="$(read_profile_pointer "${file}")"
    [ -n "${path}" ] || continue
    # A pointer is caller state, not kit convention: stale, hand-edited, or left
    # behind by a moved profile, it names whatever now sits at that path — and
    # `remove_profile` hands that straight to `rm -rf`. The convention roots are
    # deliberately not probed; their names are the contract, so a half-written
    # `~/.config/job-kit` stays removable. An absent target deletes nothing and
    # still gets its pointer cleared, so only a present one is probed.
    [ -e "${path}" ] || [ -L "${path}" ] || continue
    [ -d "${path}" ] \
      || die "refusing to delete profile root named by ${file}: not a directory: ${path}"
    missing="$(profile_probe_missing "${path}")"
    [ -z "${missing}" ] \
      || die "refusing to delete profile root named by ${file}: ${path}
missing or unreadable: ${missing} (the probe activation requires before writing that pointer)
fix or remove the pointer, or delete ${path} yourself"
  done <<EOF
$(profile_pointer_files)
EOF
}

# remove_profile — delete convention + pointer-selected profile roots, then
# clear matching profile-root pointers.
remove_profile() {
  local config host_default path host_home pointer mirror candidate
  local -a existing clear_args aliases
  existing=()
  clear_args=()
  aliases=()

  validate_profile_inputs
  config="$(job_kit_config)"
  host_default="$(host_default_root)"

  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    clear_args[${#clear_args[@]}]="${path}"
    [ -e "${path}" ] || [ -L "${path}" ] || continue
    # A symlinked root is an alias for the profile, not the profile: `rm -rf` on
    # it unlinks the alias and leaves every fact at the target, after which this
    # function still reports success and clears the pointers. Delete the physical
    # target and drop the alias afterwards. Resolving here rather than during
    # dedup is what covers a *sole* symlink root — with no second candidate
    # naming the same tree there is nothing to deduplicate against.
    if [ -L "${path}" ] && [ -d "${path}" ]; then
      aliases[${#aliases[@]}]="${path}"
      path="$(cd "${path}" && pwd -P)"
    fi
    # Deduplicate when XDG unset, pointer equals convention, or one root is a
    # symlink to the other — both sides are physical by now.
    local seen=0 e
    for e in "${existing[@]+"${existing[@]}"}"; do
      if paths_equal "${e}" "${path}"; then
        seen=1
        break
      fi
    done
    [ "${seen}" -eq 0 ] || continue
    refuse_profile_path "${path}"
    existing[${#existing[@]}]="${path}"
  done <<EOF
$(profile_delete_candidates)
EOF

  if [ "${#existing[@]}" -eq 0 ]; then
    echo "profile: already absent (${config}"
    if [ "${config}" != "${host_default}" ]; then
      echo "  and ${host_default}"
    fi
    for candidate in "${clear_args[@]+"${clear_args[@]}"}"; do
      paths_equal "${candidate}" "${config}" && continue
      paths_equal "${candidate}" "${host_default}" && continue
      echo "  (pointer also named ${candidate}, not present)"
    done
    echo ")"
  else
    echo "profile paths to delete:"
    for path in "${existing[@]}"; do
      echo "  ${path}"
    done
    # run_plan already took the typed yes at the plan gate; this tree is in it.
    for path in "${existing[@]}"; do
      rm -rf "${path}" || die "failed to remove profile: ${path}"
      echo "removed profile: ${path}"
    done
    # An alias that pointed at a deleted tree is now dangling; drop it too.
    for path in "${aliases[@]+"${aliases[@]}"}"; do
      if [ -L "${path}" ] && [ ! -e "${path}" ]; then
        rm -f "${path}" || die "failed to remove profile alias: ${path}"
        echo "removed profile alias: ${path}"
      fi
    done
  fi

  host_home="$(resolve_host_home)"
  pointer="${host_home}/.config/profile-root"
  mirror="${host_home}/.aside/runtime/home/.config/profile-root"
  # Match pointers against every candidate (convention + pointer targets).
  if [ "${#clear_args[@]}" -gt 0 ]; then
    clear_pointer_if_matches "${pointer}" "${clear_args[@]}"
    clear_pointer_if_matches "${mirror}" "${clear_args[@]}"
  fi
}

# kit_owned_missing DIR — first missing ownership file, or empty if kit-owned.
# Walks every path component and rejects a symlink at any of them: Bash
# `test -f`/`-d` follow intermediate links, so a foreign directory that keeps a
# real `skill/` but links `scripts` and each skill dir into a genuine checkout
# would pass a leaf-only probe and be handed to `rm -rf`. Same walk as
# `kit_paths_missing` in remote.sh, which guards the same decision.
kit_owned_missing() {
  local dir="$1" rel cur part rest
  if [ -L "${dir}/skill" ] || [ ! -d "${dir}/skill" ]; then
    printf '%s\n' "skill/"
    return 0
  fi
  for rel in ${KIT_OWNERSHIP_FILES}; do
    cur="${dir}"
    rest="${rel}"
    while [ -n "${rest}" ]; do
      case "${rest}" in
        */*)
          part="${rest%%/*}"
          rest="${rest#*/}"
          ;;
        *)
          part="${rest}"
          rest=""
          ;;
      esac
      [ -n "${part}" ] || continue
      cur="${cur}/${part}"
      if [ -L "${cur}" ]; then
        printf '%s\n' "${rel}"
        return 0
      fi
    done
    if [ ! -f "${dir}/${rel}" ]; then
      if [ "${rel}" = "skill/job-profile/SKILL.md" ] \
        && [ ! -L "${dir}/skill/job-profile-init" ] \
        && [ ! -L "${dir}/skill/job-profile-init/SKILL.md" ] \
        && [ -f "${dir}/skill/job-profile-init/SKILL.md" ]; then
        continue
      fi
      printf '%s\n' "${rel}"
      return 0
    fi
  done
}

# resolve_cache_path PATH — physical path when PATH is a live symlink to a dir.
resolve_cache_path() {
  local raw
  raw="$(strip_trailing_slashes "$1")"
  if [ -L "${raw}" ]; then
    [ -d "${raw}" ] || die "cache symlink is dangling: ${raw}"
    (cd "${raw}" && pwd -P)
    return 0
  fi
  printf '%s\n' "${raw}"
}

# owned_by_root PATH NAME ROOT…
# Prints PATH when it is a skill symlink, or a marked copy, whose source is
# ROOT/skill/NAME for any ROOT given. Always returns 0 so callers survive
# `set -e`.
owned_by_root() {
  local path="$1" name="$2" current root
  shift 2
  if [ -L "${path}" ]; then
    current="$(readlink "${path}")"
  elif [ -d "${path}" ] && [ -f "${path}/.job-kit" ]; then
    current="$(cat "${path}/.job-kit")"
  else
    return 0
  fi
  for root in "$@"; do
    if [ "${current}" = "${root}/skill/${name}" ]; then
      printf '%s\n' "${path}"
      return 0
    fi
  done
  return 0
}

# owned_kind PATH — "link" or "copy", the two forms owned_by_root reads.
owned_kind() {
  if [ -L "$1" ]; then
    printf 'link\n'
  elif [ -d "$1" ] && [ -f "$1/.job-kit" ]; then
    printf 'copy\n'
  fi
}

# plan_row DEST NAME TAG LINK_ONLY — one manifest row for a skill path.
# Ownership is decided by owned_by_root against REPO_ROOT, the same comparison
# the mutators make (aside/lib.sh:102,116 and agents/lib.sh:136).
# LINK_ONLY=1 for the agents channel: agents/lib.sh:300 requires is_kit_skill_link,
# so a marked copy under an agent root is skipped at apply time and must not be
# promised here. owned_by_root always returns 0 (see above) — test output, not status.
plan_row() {
  local dest="$1" name="$2" tag="$3" link_only="${4:-0}" hit kind
  hit="$(owned_by_root "${dest}" "${name}" "${REPO_ROOT}")"
  kind="$(owned_kind "${dest}")"
  if [ -n "${hit}" ] && { [ "${link_only}" -eq 0 ] || [ "${kind}" = link ]; }; then
    printf 'I%sremove %s (%s)%s%s\n' "${ROW_FS}" "${kind}" "${tag}" "${ROW_FS}" "${dest}"
  elif [ -e "${dest}" ] || [ -L "${dest}" ]; then
    printf 'N%snot kit-owned%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  elif [ "${tag}" = current ]; then
    printf 'N%snot installed%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  fi
}

# plan_row_worker_agent_removal — the Claude worker agent copy row.
# Rows: I remove copy | N not kit-owned | N not installed. Needs agents/lib.sh sourced.
plan_row_worker_agent_removal() {
  local dest
  dest="$(worker_agent_dest)"
  if [ -f "${dest}" ] && [ ! -L "${dest}" ] && grep -qF -- "${WORKER_AGENT_MARKER}" "${dest}"; then
    printf 'I%sremove copy%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  elif [ -e "${dest}" ] || [ -L "${dest}" ]; then
    printf 'N%snot kit-owned%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  else
    printf 'N%snot installed%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  fi
}

# plan_rows_aside — rows for the aside target. No mutation.
# Mirrors uninstall_aside (below): LEGACY_SKILL_NAMES then SKILL_NAMES at the
# resolved root, then the legacy user root. That second root is re-derived here
# because aside/lib.sh:290 inlines it and exposes no accessor; the same-physical-
# path guard aside/lib.sh:292-299 makes is mirrored with it, or the plan
# double-reports under an ASIDE_SKILLS override.
plan_rows_aside() {
  local repo="${REPO_ROOT}"
  (
    # shellcheck source=aside/lib.sh
    . "${repo}/scripts/aside/lib.sh"
    local dest_root user_root name
    dest_root="$(resolve_aside_skills_root)" || exit 1
    printf 'H%saside%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest_root}"
    legacy_walk="${LEGACY_SKILL_NAMES}"
    for name in ${legacy_walk}; do
      plan_row "$(skill_dest "${dest_root}" "${name}")" "${name}" legacy
    done
    for name in ${SKILL_NAMES}; do
      plan_row "$(skill_dest "${dest_root}" "${name}")" "${name}" current
    done
    user_root="${HOME}/.aside/u/${ASIDE_ACCOUNT_ID}/skills/user"
    [ -d "${user_root}" ] || exit 0
    printf 'H%saside (legacy user root)%s%s\n' "${ROW_FS}" "${ROW_FS}" "${user_root}"
    for name in ${legacy_walk}; do
      plan_row "$(skill_dest "${user_root}" "${name}")" "${name}" legacy
    done
    # aside/lib.sh:295 stops after legacy names when the two roots are one tree.
    paths_equal "${user_root}" "${dest_root}" && exit 0
    for name in ${SKILL_NAMES}; do
      plan_row "$(skill_dest "${user_root}" "${name}")" "${name}" current
    done
  )
}

# plan_rows_agents — rows for the agents target. No mutation.
# Mirrors uninstall_agents (below), including the override early exit (which also
# makes the legacy Codex sweep unreachable) and the
# parent-or-root eligibility test. link_only=1 throughout: agents/lib.sh:300
# requires a symlink, never a marked copy.
plan_rows_agents() {
  local repo="${REPO_ROOT}"
  (
    # shellcheck source=agents/lib.sh
    . "${repo}/scripts/agents/lib.sh"
    local override target root parent label name
    override="$(resolve_override_skills)" || exit 1
    if [ -n "${override}" ]; then
      printf 'H%sagents (override)%s%s\n' "${ROW_FS}" "${ROW_FS}" "${override}"
      for name in ${LEGACY_SKILL_NAMES} $(agents_names_for_root "${override}" "${repo}"); do
        plan_row "$(skill_dest "${override}" "${name}")" "${name}" current 1
      done
      exit 0
    fi
    for target in ${AGENT_TARGETS}; do
      root="$(agent_skills_root "${target}")"
      label="$(agent_label "${target}")"
      parent="$(agent_parent_dir "${target}")"
      if [ ! -d "${parent}" ] && [ ! -d "${root}" ]; then
        printf 'N%snothing to uninstall%s%s\n' "${ROW_FS}" "${ROW_FS}" "${root}"; continue
      fi
      printf 'H%sagents · %s%s%s\n' "${ROW_FS}" "${label}" "${ROW_FS}" "${root}"
      for name in ${LEGACY_SKILL_NAMES}; do
        plan_row "$(skill_dest "${root}" "${name}")" "${name}" legacy 1
      done
      for name in $(agents_names_for_root "${root}" "${repo}"); do
        plan_row "$(skill_dest "${root}" "${name}")" "${name}" current 1
      done
      if [ "${target}" = claude ]; then
        plan_row_worker_agent_removal
      fi
    done
    root="${HOME}/.codex/skills"
    [ -d "${root}" ] || [ -L "${root}" ] || exit 0
    printf 'H%sagents (legacy Codex root)%s%s\n' "${ROW_FS}" "${ROW_FS}" "${root}"
    for name in ${SKILL_NAMES} ${LEGACY_SKILL_NAMES}; do
      plan_row "$(skill_dest "${root}" "${name}")" "${name}" legacy 1
    done
  )
}

# plan_rows_browser_use — rows for the browser-use target. No mutation.
# Mirrors plan_rows_agents over BROWSER_SKILL_NAMES, then adds the driver
# section. Two deliberate differences from that mirror:
#   - legacy rows come from BROWSER_LEGACY_SKILL_NAMES, not the agents-channel
#     list, and there is no legacy Codex root — this channel never installed
#     there;
#   - the override branch does not end the walk: a prior --target install may
#     still sit under the default homes, and --path may have written the
#     driver under CLAUDE_SKILLS as well.
# link_only=1 throughout: this channel only ever symlinks (agents/lib.sh:300).
plan_rows_browser_use() {
  local repo="${REPO_ROOT}" state
  state="$(browser_harness_state)"
  (
    # shellcheck source=agents/lib.sh
    . "${repo}/scripts/agents/lib.sh"
    local override target root parent label name dest bin agents_owned n
    override="$(resolve_override_skills)" || exit 1
    plan_browser_shared_deps() {
      local plan_root="$1" agents_owned=0 pn pname
      case " ${UNINSTALL_TARGETS} " in
        *" agents "*)
          for pname in ${BROWSER_SHARED_DEPS}; do
            plan_row "$(skill_dest "${plan_root}" "${pname}")" "${pname}" current 1
          done
          return 0
          ;;
      esac
      for pn in job-stories job-inbox; do
        if is_kit_skill_link "$(skill_dest "${plan_root}" "${pn}")" "${repo}" "${pn}"; then
          agents_owned=1
          break
        fi
      done
      for pname in ${BROWSER_SHARED_DEPS}; do
        if [ "${agents_owned}" -eq 1 ]; then
          case " ${SKILL_NAMES} " in
            *" ${pname} "*) continue ;;
          esac
        fi
        plan_row "$(skill_dest "${plan_root}" "${pname}")" "${pname}" current 1
      done
    }
    if [ -n "${override}" ]; then
      printf 'H%sbrowser-use (override)%s%s\n' "${ROW_FS}" "${ROW_FS}" "${override}"
      for name in ${BROWSER_SKILL_NAMES}; do
        plan_row "$(skill_dest "${override}" "${name}")" "${name}" current 1
      done
      for name in ${BROWSER_LEGACY_SKILL_NAMES}; do
        plan_row "$(skill_dest "${override}" "${name}")" "${name}" legacy 1
      done
      plan_browser_shared_deps "${override}"
    else
      for target in ${AGENT_TARGETS}; do
        root="$(agent_skills_root "${target}")"
        label="$(agent_label "${target}")"
        parent="$(agent_parent_dir "${target}")"
        if [ ! -d "${parent}" ] && [ ! -d "${root}" ]; then
          printf 'N%snothing to uninstall%s%s\n' "${ROW_FS}" "${ROW_FS}" "${root}"; continue
        fi
        printf 'H%sbrowser-use · %s%s%s\n' "${ROW_FS}" "${label}" "${ROW_FS}" "${root}"
        for name in ${BROWSER_SKILL_NAMES}; do
          plan_row "$(skill_dest "${root}" "${name}")" "${name}" current 1
        done
        for name in ${BROWSER_LEGACY_SKILL_NAMES}; do
          plan_row "$(skill_dest "${root}" "${name}")" "${name}" legacy 1
        done
        plan_browser_shared_deps "${root}"
      done
    fi
    # The driver is browser-use's own installation, not kit-owned, so there is no
    # ownership predicate to state — a row appears only when the artifact is
    # actually on disk, and uninstall_browser_use removes exactly this set.
    printf 'H%sbrowser-use · driver (not kit-owned)%s%s\n' "${ROW_FS}" "${ROW_FS}" "browser-use"
    if [ -n "${override}" ]; then
      dest="${override}/browser-use"
      if [ -e "${dest}" ] || [ -L "${dest}" ]; then
        printf 'I%sremove driver%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
      fi
    fi
    for target in ${AGENT_TARGETS}; do
      root="$(agent_skills_root "${target}")"
      dest="${root}/browser-use"
      if [ -n "${override}" ] && [ "${dest}" = "${override}/browser-use" ]; then
        continue
      fi
      if [ ! -e "${dest}" ] && [ ! -L "${dest}" ]; then
        continue
      fi
      printf 'I%sremove driver%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
    done
    bin="$(command -v browser-use 2>/dev/null || true)"
    if [ -n "${bin}" ]; then
      printf 'I%sremove CLI%s%s\n' "${ROW_FS}" "${ROW_FS}" "${bin}"
    fi
    if [ -d "${state}" ]; then
      printf 'I%sremove state%s%s\n' "${ROW_FS}" "${ROW_FS}" "${state}"
    fi
    # A browser predates and outlives this kit; say so in the plan rather than
    # leave its absence looking like an oversight.
    printf 'N%sleft installed%s%s\n' "${ROW_FS}" "${ROW_FS}" "Google Chrome (this kit never removes a browser)"
  )
}

# plan_rows_profile — rows for the profile target. No mutation, and no refusal:
# refuse_profile_path and the removability walks stay in preflight_targets,
# which runs after the render. Resolves a symlinked candidate exactly as
# remove_profile does below, so the X row names the tree rm -rf will walk.
plan_rows_profile() {
  local path pointer
  local -a existing
  existing=()
  printf 'H%sprofile%s%s\n' "${ROW_FS}" "${ROW_FS}" "$(job_kit_config)"
  while IFS= read -r path; do
    [ -n "${path}" ] || continue
    [ -e "${path}" ] || [ -L "${path}" ] || continue
    if [ -L "${path}" ] && [ -d "${path}" ]; then
      printf 'X%sremove alias%s%s\n' "${ROW_FS}" "${ROW_FS}" "${path}"
      path="$(cd "${path}" && pwd -P)"
    fi
    local seen=0 e
    for e in "${existing[@]+"${existing[@]}"}"; do
      paths_equal "${e}" "${path}" && { seen=1; break; }
    done
    [ "${seen}" -eq 0 ] || continue
    existing[${#existing[@]}]="${path}"
    printf 'X%sDELETE TREE%s%s\n' "${ROW_FS}" "${ROW_FS}" "${path}"
  done <<EOF
$(profile_delete_candidates)
EOF
  [ "${#existing[@]}" -ne 0 ] \
    || printf 'N%salready absent%s%s\n' "${ROW_FS}" "${ROW_FS}" "$(job_kit_config)"
  # remove_profile clears pointers on both branches, including the already-absent
  # one, and clear_pointer_if_matches drops an empty pointer unconditionally — so
  # an existing pointer file is always a row.
  while IFS= read -r pointer; do
    [ -n "${pointer}" ] || continue
    if [ -f "${pointer}" ]; then
      printf 'I%sclear pointer%s%s\n' "${ROW_FS}" "${ROW_FS}" "${pointer}"
    else
      printf 'N%spointer absent%s%s\n' "${ROW_FS}" "${ROW_FS}" "${pointer}"
    fi
  done <<EOF
$(profile_pointer_files)
EOF
}

# plan_rows_cache — row for the cache target. No mutation.
# Ownership and removability stay with purge_preflight; this states intent and
# the refusal prints after it with its reason.
plan_rows_cache() {
  local raw dest
  raw="$(strip_trailing_slashes "${JOB_KIT_HOME}")"
  printf 'H%scache%s%s\n' "${ROW_FS}" "${ROW_FS}" "${raw}"
  if [ ! -L "${raw}" ] && [ ! -e "${raw}" ]; then
    printf 'N%salready absent%s%s\n' "${ROW_FS}" "${ROW_FS}" "${raw}"
    return 0
  fi
  dest="$(resolve_cache_path "${raw}")"
  printf 'X%sPURGE CACHE%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  # purge_cache drops a live symlink in a second step after the tree, so the
  # link is its own removal — the manifest counts it like the profile aliases.
  [ ! -L "${raw}" ] \
    || printf 'X%sremove alias%s%s\n' "${ROW_FS}" "${ROW_FS}" "${raw}"
}

# build_plan TARGET… — every manifest row, in apply order.
build_plan() {
  local t
  for t in "$@"; do
    case "${t}" in
      aside) plan_rows_aside ;;
      agents) plan_rows_agents ;;
      browser-use) plan_rows_browser_use ;;
      profile) plan_rows_profile ;;
      cache) plan_rows_cache ;;
    esac
  done
}

# render_plan ROWS — print the manifest to stdout.
# Grouped sections, tilde paths, skill basenames; collapse consecutive same-status
# skill N-rows into one comma list. Producers still emit absolute paths.
render_plan() {
  local rows="$1" kind label path
  local section_root="" section_started=0
  local pend_label="" pend_names="" leaf action tag rest

  # flush_pend — emit collapsed N skill names, if any.
  flush_pend() {
    [ -n "${pend_label}" ] || return 0
    printf '  %-16s %s\n' "${pend_label}" "${pend_names}"
    pend_label=""
    pend_names=""
  }

  # emit_body KIND LABEL PATH — one non-header row (after skill collapse rules).
  emit_body() {
    local k="$1" lab="$2" p="$3"
    leaf=""
    [ -n "${section_root}" ] && leaf="$(skill_leaf "${section_root}" "${p}")"

    if [ "${k}" = N ] && [ -n "${leaf}" ]; then
      if [ "${pend_label}" = "${lab}" ]; then
        pend_names="${pend_names}, ${leaf}"
        return 0
      fi
      flush_pend
      pend_label="${lab}"
      pend_names="${leaf}"
      return 0
    fi

    flush_pend

    if [ "${k}" = I ] && [ -n "${leaf}" ]; then
      # Labels from plan_row: "remove link (current)" / "remove copy (legacy)".
      case "${lab}" in
        "remove link ("*")"|"remove copy ("*")")
          rest="${lab#remove }"
          action="remove ${rest%% (*}"
          tag="${rest#* (}"
          tag="${tag%)}"
          printf '  %-16s %s (%s)\n' "${action}" "${leaf}" "${tag}"
          return 0
          ;;
      esac
    fi

    if [ "${k}" = X ]; then
      printf '  %-16s %s  · irreversible\n' "${lab}" "$(path_display "${p}")"
    else
      printf '  %-16s %s\n' "${lab}" "$(path_display "${p}")"
    fi
  }

  echo "job-kit uninstall · plan"
  echo
  while IFS="${ROW_FS}" read -r kind label path; do
    [ -n "${kind}" ] || continue
    if [ "${kind}" = H ]; then
      flush_pend
      if [ "${section_started}" -eq 1 ]; then
        echo
      fi
      section_started=1
      section_root="${path}"
      printf '%s  ·  %s\n' "${label}" "$(path_display "${path}")"
    else
      emit_body "${kind}" "${label}" "${path}"
    fi
  done <<EOF
${rows}
EOF
  flush_pend
  echo "--------------------------------------------------------------"
}

# confirm_plan REMOVALS IRREVERSIBLE — the single gate for the whole run.
# Two tiers, chosen by the irreversible row count: profile or cache data needs a
# typed "yes"; anything re-installable takes [Y/n]. On a pipe `read` returns
# empty, so re-installable targets apply after the plan and profile/cache refuse.
# Side effects: reads stdin.
confirm_plan() {
  local removals="$1" irreversible="$2" answer
  if [ "${irreversible}" -gt 0 ]; then
    confirm_yes "Proceed? Profile/cache data cannot be recovered. Type yes: "
    return $?
  fi
  printf 'Proceed? %s removals, all re-installable. [Y/n] ' "${removals}" >&2
  read -r answer || true
  case "${answer}" in
    ''|y|Y|yes) return 0 ;;
    *) echo "aborted." >&2; return 1 ;;
  esac
}

# plan_preflight TARGET… — prove the manifest can be truthful before it prints.
# Only the guards whose failure would make the plan *wrong*: absolute pointer
# lines, channel roots that resolve, and paths whose absence must be provable.
# Everything about whether removal can succeed stays in preflight_targets.
plan_preflight() {
  local t blocker raw
  for t in "$@"; do
    if [ "${t}" = aside ]; then
      ( . "${REPO_ROOT}/scripts/aside/lib.sh"; resolve_aside_skills_root >/dev/null ) \
        || die "refusing to start: the aside target cannot resolve its skills root"
    elif [ "${t}" = agents ]; then
      ( . "${REPO_ROOT}/scripts/agents/lib.sh"; resolve_override_skills >/dev/null ) \
        || die "refusing to start: the agents target cannot resolve its skills root"
    elif [ "${t}" = browser-use ]; then
      ( . "${REPO_ROOT}/scripts/agents/lib.sh"; resolve_override_skills >/dev/null ) \
        || die "refusing to start: the browser-use target cannot resolve its skills root"
      # Prove the driver state path here, at this shell: `die` inside the row
      # builder's command substitution would only kill that subshell.
      browser_harness_state >/dev/null
    elif [ "${t}" = profile ]; then
      validate_profile_inputs
    elif [ "${t}" = cache ]; then
      raw="$(strip_trailing_slashes "${JOB_KIT_HOME}")"
      blocker="$(first_uninspectable "${raw}")"
      [ -z "${blocker}" ] \
        || die "refusing to start: the cache path cannot be inspected at ${blocker}, so its absence cannot be proven: ${raw}"
    fi
  done
}

# first_uninspectable PATH — the first existing component of PATH that cannot be
# read and searched, or nothing when the whole chain is inspectable (an absent
# component ends the walk: absent is a real answer).
# A directory that cannot be searched hides its children from `test`, so every
# probe below it returns "not there" — indistinguishable from "nothing to find".
# This scan stands in front of `rm -rf`, so it must tell those apart.
# Side effects: none.
first_uninspectable() {
  local path="$1" cur="" part rest
  rest="${path#/}"
  while [ -n "${rest}" ]; do
    case "${rest}" in
      */*)
        part="${rest%%/*}"
        rest="${rest#*/}"
        ;;
      *)
        part="${rest}"
        rest=""
        ;;
    esac
    [ -n "${part}" ] || continue
    cur="${cur}/${part}"
    [ -e "${cur}" ] || return 0
    if [ ! -r "${cur}" ] || [ ! -x "${cur}" ]; then
      printf '%s\n' "${cur}"
      return 0
    fi
  done
}

# links_owned_by DEST — installed skill paths whose source is the checkout at DEST.
# The channel libs decide ownership as `readlink == <repo>/skill/<name>` against
# this script's REPO_ROOT, so an install made from a different checkout is
# skipped as "not kit-owned". Purging DEST would then strand those links behind
# a report claiming the uninstall completed.
# Installers record the source as `pwd -P`, which differs from DEST whenever an
# ancestor is a symlink (`/var` → `/private/var`), so both forms are matched.
# Side effects: none.
# home_bases — `$HOME`, plus the resolved host home when it differs.
# Inside Aside, HOME is <host>/.aside/runtime/home while the links were
# installed under the host home, so every scan visits both.
home_bases() {
  local host_home
  printf '%s\n' "${HOME}"
  host_home="$(resolve_host_home)"
  [ "${host_home}" = "${HOME}" ] || printf '%s\n' "${host_home}"
}

links_owned_by() {
  local dest="$1" scope="${2:-all}" phys
  phys="${dest}"
  if [ -d "${dest}" ]; then
    phys="$(cd "${dest}" && pwd -P)" || phys="${dest}"
  fi
  (
    # shellcheck source=agents/lib.sh
    . "${REPO_ROOT}/scripts/agents/lib.sh"
    local target root rel base
    # scan_root ROOT — report kit-owned skill paths under ROOT.
    scan_root() {
      local r="$1" n blocker
      blocker="$(first_uninspectable "${r}")"
      if [ -n "${blocker}" ]; then
        printf '%s\n' "${blocker} (exists but cannot be inspected)"
        return 0
      fi
      # The union, not SKILL_NAMES: a browser-channel link under an agent home
      # is just as stranded by a purge as a profile one, whichever target
      # installed it.
      for n in ${ALL_SKILL_NAMES} ${LEGACY_SKILL_NAMES}; do
        owned_by_root "$(skill_dest "${r}" "${n}")" "${n}" "${dest}" "${phys}"
      done
    }
    # Override install root: uninstall_agents only walks CLAUDE_SKILLS when set.
    override="$(resolve_override_skills)" || true
    if [ -n "${override:-}" ]; then
      scan_root "${override}"
    fi
    while IFS= read -r base; do
      for target in ${AGENT_TARGETS}; do
        # agent_skills_root is $HOME-relative; re-anchor its suffix per base.
        root="$(agent_skills_root "${target}")"
        rel="${root#"${HOME}/"}"
        if [ "${rel}" = "${root}" ]; then
          rel=""
        else
          root="${base}/${rel}"
        fi
        # scope=survivors lists only what the unlink phase will NOT reach.
        # uninstall_agents walks the raw $HOME roots. When CLAUDE_SKILLS is set,
        # uninstall_agents never touches the defaults, so they stay in the
        # survivor set. Exempt a root only when it can actually be inspected:
        # an unsearchable one hides its links from uninstall_agents too.
        if [ "${scope}" = survivors ] && [ "${base}" = "${HOME}" ] \
          && [ -z "${override:-}" ] \
          && [ -z "$(first_uninspectable "${root}")" ]; then
          continue
        fi
        scan_root "${root}"
      done
      # Older docs pointed Codex at ~/.codex/skills, and
      # `remove_legacy_codex_skills_dir` still unlinks there — so under the raw
      # $HOME it is normally not a survivor. Except with an override set:
      # uninstall_agents returns right after walking CLAUDE_SKILLS and never
      # reaches that call, so the legacy root survives the unlink phase and has
      # to be scanned like any other root the phase cannot reach.
      if [ "${scope}" != survivors ] || [ "${base}" != "${HOME}" ] \
        || [ -n "${override:-}" ]; then
        scan_root "${base}/.codex/skills"
      fi
    done <<EOF
$(home_bases)
EOF
  )
  (
    # shellcheck source=aside/lib.sh
    . "${REPO_ROOT}/scripts/aside/lib.sh"
    local base account_dir blocker aside_override
    # Override install root: uninstall_aside walks only this when set, exactly as
    # resolve_aside_skills_root picks it.
    aside_override="${ASIDE_SKILLS:-}"
    scan_root() {
      local r="$1" n blocker
      blocker="$(first_uninspectable "${r}")"
      if [ -n "${blocker}" ]; then
        printf '%s\n' "${blocker} (exists but cannot be inspected)"
        return 0
      fi
      for n in ${SKILL_NAMES} ${LEGACY_SKILL_NAMES}; do
        owned_by_root "$(skill_dest "${r}" "${n}")" "${n}" "${dest}" "${phys}"
      done
    }
    # When ASIDE_SKILLS is set, scan that root too (same as
    # uninstall_aside). Default u/* walk stays for non-override installs and for
    # skills under other accounts.
    # Every existing u/<account> is walked, not just ASIDE_ACCOUNT: skills
    # installed under another account outlive a purge run without it set.
    # `builtin` is the current root; `user` is the legacy one
    # remove_legacy_user_skills clears.
    if [ -n "${ASIDE_SKILLS:-}" ]; then
      case "${ASIDE_SKILLS}" in
        /*) scan_root "${ASIDE_SKILLS}" ;;
      esac
    fi
    while IFS= read -r base; do
      # An account tree that cannot be traversed is not an absent one: the glob
      # silently yields nothing and the scan would report all clear. Walk the
      # whole enumeration path first — `-e` on `.aside/u` is itself false when
      # an ancestor like `.aside` is unsearchable, which would skip this guard.
      blocker="$(first_uninspectable "${base}/.aside/u")"
      if [ -n "${blocker}" ]; then
        printf '%s\n' "${blocker} (exists but cannot be inspected)"
        continue
      fi
      # An account id is one path component but may begin with a dot, which `*`
      # does not enumerate: a skill under `u/.hidden` would be invisible to both
      # scans and the cache purged out from under it. `.[!.]*` and `..?*` add the
      # dot-prefixed forms while skipping `.` and `..`; an unmatched pattern stays
      # literal and the `-d` test below drops it, as it drops plain dotfiles.
      for account_dir in "${base}"/.aside/u/*/ "${base}"/.aside/u/.[!.]*/ \
        "${base}"/.aside/u/..?*/; do
        [ -d "${account_dir}" ] || continue
        # scope=survivors: uninstall_aside only reaches ASIDE_ACCOUNT under the
        # raw $HOME, so every other account — and every other base — survives it.
        # Exempt it only when both of its roots are inspectable: an unsearchable
        # one hides its links from uninstall_aside too, exactly as for agents.
        if [ "${scope}" = survivors ] && [ "${base}" = "${HOME}" ] \
          && [ "${account_dir}" = "${base}/.aside/u/${ASIDE_ACCOUNT_ID}/" ] \
          && [ -z "$(first_uninspectable "${account_dir}skills/builtin")" ] \
          && [ -z "$(first_uninspectable "${account_dir}skills/user")" ]; then
          # An override sends the unlink phase to that root instead, so
          # skills/builtin is not covered by the exemption; scan it or an
          # irreversible remove_profile runs before the purge finds the link.
          # remove_legacy_user_skills still clears skills/user either way.
          [ -z "${aside_override}" ] || scan_root "${account_dir}skills/builtin"
          continue
        fi
        scan_root "${account_dir}skills/builtin"
        scan_root "${account_dir}skills/user"
      done
    done <<EOF
$(home_bases)
EOF
  )
}

# purge_env_guards — no longer refuses overrides; links_owned_by scans them.
# Kept as a no-op hook so call sites stay stable. Overrides must stay set for
# the scan to see custom install roots (nothing on disk records dest).
purge_env_guards() {
  :
}

# purge_preflight [SCOPE] — prove the cache purge can finish before anything is
# deleted. `remove_profile` is irreversible, so every purge guard that does not
# depend on the unlink phase runs first.
# SCOPE `survivors` means an aside+agents unlink phase precedes the purge in this
# run: only links that phase cannot reach are blockers. SCOPE `all` (default)
# means nothing will be unlinked first, so every live link blocks.
# A cache this checkout does not own is always scanned in full — the unlink phase
# skips those links as non-kit whatever it walks.
# tree_unremovable DIR — why `rm -rf DIR` would fail, or nothing.
# Removal needs three things the fixed-path ownership probes never test: the tree
# must enumerate, every directory in it must be writable (entries are unlinked
# from their parent), and DIR's own parent must be writable to drop DIR itself.
# Writability is tested with `-w`, which asks whether *this* process may write.
# A mode-bit test (`find -perm -u+w`) answers for the owner instead, and passes a
# root-owned 0755 tree that an unprivileged caller cannot touch.
# A dangling symlink is still a removable thing: `-e` is false for one, so the
# entry test admits `-L` too, or `rm -f` on it fails after the real tree is gone.
# Side effects: none.
tree_unremovable() {
  local dir="$1" errs parent d entry euid unwritable="" protected=""
  [ -e "${dir}" ] || [ -L "${dir}" ] || return 0
  errs="$(find "${dir}" -print 2>&1 >/dev/null)" || true
  if [ -n "${errs}" ]; then
    printf '%s' "${errs}"
    return 0
  fi
  euid="$(id -u)"
  # NUL-delimited: a directory name may itself contain a newline, and a
  # line-delimited read splits it into two paths that name something else —
  # both of which can be writable while the real directory is not.
  while IFS= read -r -d '' d; do
    [ -n "${d}" ] || continue
    if [ ! -w "${d}" ]; then
      unwritable="${unwritable}${d}
"
      continue
    fi
    # A sticky directory this user does not own lets them unlink only their own
    # entries, whatever `-w` reports — `/tmp` is the familiar case. Root is
    # exempt from that restriction, so only an unprivileged run is constrained.
    [ "${euid}" -ne 0 ] && [ -k "${d}" ] && [ ! -O "${d}" ] || continue
    for entry in "${d}"/* "${d}"/.[!.]* "${d}"/..?*; do
      [ -e "${entry}" ] || [ -L "${entry}" ] || continue
      [ -O "${entry}" ] || protected="${protected}${entry}
"
    done
  done < <(find "${dir}" -type d -print0 2>/dev/null)
  if [ -n "${unwritable}" ]; then
    printf 'not writable by this user, so their contents cannot be unlinked:\n%s' "${unwritable}"
    return 0
  fi
  if [ -n "${protected}" ]; then
    printf 'owned by another user inside a sticky directory, so they cannot be unlinked:\n%s' "${protected}"
    return 0
  fi
  parent="$(dirname "${dir}")"
  if [ ! -w "${parent}" ]; then
    printf '%s is not writable, so %s itself cannot be removed' "${parent}" "${dir}"
  fi
}

purge_preflight() {
  local scope="${1:-all}" raw dest missing outstanding unwalkable blocker
  purge_env_guards
  raw="$(strip_trailing_slashes "${JOB_KIT_HOME}")"
  # An unsearchable ancestor hides the cache from both probes, and the run then
  # reports "cache already absent" after an earlier irreversible target has
  # already gone through. Absence is only believable once the path can be walked.
  blocker="$(first_uninspectable "${raw}")"
  [ -z "${blocker}" ] \
    || die "refusing to start: the cache path cannot be inspected at ${blocker}, so its absence cannot be proven: ${raw}"
  if [ ! -L "${raw}" ] && [ ! -e "${raw}" ]; then
    return 0
  fi
  dest="$(resolve_cache_path "${raw}")"
  missing="$(kit_owned_missing "${dest}")"
  [ -z "${missing}" ] \
    || die "refusing to start: the cache purge would fail on a non-kit path (missing ${missing}): ${dest}"
  # The ownership probe reads fixed paths, which a searchable-but-unreadable
  # tree still answers; `rm -rf` has to enumerate it. Prove that now, or an
  # earlier irreversible target runs and the purge fails afterwards.
  unwalkable="$(tree_unremovable "${dest}")"
  [ -z "${unwalkable}" ] \
    || die "refusing to start: the cache at ${dest} cannot be removed, so the purge would fail partway:
${unwalkable}"
  # A symlinked JOB_KIT_HOME is removed in two steps: `rm -rf` on the target,
  # then `rm -f` on the link. The second needs the *link's* parent writable,
  # which the target's own tree never reports — so a link in an unwritable
  # directory would delete the cache (and any earlier irreversible target) and
  # then fail, stranding a dangling path.
  if [ -L "${raw}" ]; then
    unwalkable="$(tree_unremovable "${raw}")"
    [ -z "${unwalkable}" ] \
      || die "refusing to start: the cache symlink ${raw} cannot be removed, so the purge would fail partway:
${unwalkable}"
  fi
  if ! paths_equal "${dest}" "${REPO_ROOT}"; then
    scope=all
  fi
  outstanding="$(links_owned_by "${dest}" "${scope}")"
  [ -z "${outstanding}" ] || die "refusing to start: installed skills point at ${dest} and this run will not remove them:
${outstanding}
uninstall those skills first, or run the uninstaller from ${dest}"
}

# purge_cache — remove kit-owned JOB_KIT_HOME only.
purge_cache() {
  local raw dest missing outstanding
  raw="$(strip_trailing_slashes "${JOB_KIT_HOME}")"

  purge_env_guards

  if [ ! -L "${raw}" ] && [ ! -e "${raw}" ]; then
    echo "cache already absent: ${raw}"
    return 0
  fi

  dest="$(resolve_cache_path "${raw}")"
  missing="$(kit_owned_missing "${dest}")"
  [ -z "${missing}" ] \
    || die "refusing to purge non-kit path (missing ${missing}): ${dest}"

  # Any live link into the cache would dangle once it is gone. Checked whatever
  # root this script runs from: `all` reaches here with the links already
  # unlinked, while the standalone `cache` target — and a run from another
  # checkout, which skips them as non-kit — would otherwise strand them.
  outstanding="$(links_owned_by "${dest}")"
  [ -z "${outstanding}" ] || die "refusing to purge ${dest}: these still point at it, or could not be inspected:
${outstanding}
uninstall those skills first (\`uninstall.sh aside agents\`, or \`all\`)"

  # run_plan already took the typed yes at the plan gate; this cache is in it.
  rm -rf "${dest}" || die "failed to remove cache: ${dest}"
  if [ -L "${raw}" ]; then
    rm -f "${raw}" || die "failed to remove cache symlink: ${raw}"
  fi
  echo "purged cache: ${dest}"
}

# preflight_targets TARGET… — prove every target's prerequisites up front.
# `remove_profile` and `purge_cache` cannot be undone, so a channel that would
# refuse to resolve its skills root has to say so before the first removal.
preflight_targets() {
  local t roots root blocker pointer
  for t in "$@"; do
    case "${t}" in
      # browser-use shares this resolver: same libs, same agent homes, same
      # override rule — only the name set it will unlink differs, and that is
      # unremovable_skill_entries' business.
      agents|browser-use)
        # The resolve check stays its own subshell: `set -e` does not abort a
        # command substitution that sits in a `||` list, so folding it into the
        # roots capture below would silently drop it.
        (
          # shellcheck source=agents/lib.sh
          . "${REPO_ROOT}/scripts/agents/lib.sh"
          resolve_override_skills >/dev/null
        ) || die "refusing to start: the ${t} target cannot resolve its skills root"
        roots="$(
          # shellcheck source=agents/lib.sh
          . "${REPO_ROOT}/scripts/agents/lib.sh"
          override="$(resolve_override_skills)" || exit 1
          if [ -n "${override}" ]; then
            printf '%s\n' "${override}"
          else
            for target in ${AGENT_TARGETS}; do
              agent_skills_root "${target}"
            done
            # The legacy Codex root is walked by the agents target only:
            # uninstall_browser_use never calls remove_legacy_codex_skills_dir,
            # so refusing on that root would block a target that cannot touch it.
            if [ "${t}" = agents ]; then
              printf '%s\n' "${HOME}/.codex/skills"
            fi
          fi
        )"
        unwritable_roots "${roots}" "${t}"
        unremovable_skill_entries "${roots}" "${t}"
        ;;
      aside)
        (
          # shellcheck source=aside/lib.sh
          . "${REPO_ROOT}/scripts/aside/lib.sh"
          resolve_aside_skills_root >/dev/null
        ) || die "refusing to start: the aside target cannot resolve its skills root"
        roots="$(
          # shellcheck source=aside/lib.sh
          . "${REPO_ROOT}/scripts/aside/lib.sh"
          resolve_aside_skills_root
          printf '%s\n' "${HOME}/.aside/u/${ASIDE_ACCOUNT_ID}/skills/user"
        )"
        unwritable_roots "${roots}" aside
        unremovable_copies "${roots}"
        unremovable_skill_entries "${roots}" aside
        ;;
      profile)
        # Absolute XDG + pointer lines at this shell first (die must not be
        # swallowed by $()). Then overlap refuse + removable trees before any
        # channel unlinks — mirrors purge_preflight's irreversible ordering.
        validate_profile_inputs
        # The pointers are unlinked with `rm -f`, which needs their parent
        # directory writable, not the file. `remove_profile` clears them only
        # after `rm -rf` has run, so an unwritable `.config` fails with the
        # profile already gone, the pointer still naming it, and any later target
        # never reached. An absent pointer is never touched, so never a blocker.
        while IFS= read -r pointer; do
          [ -n "${pointer}" ] || continue
          [ -f "${pointer}" ] || continue
          blocker="$(tree_unremovable "${pointer}")"
          [ -z "${blocker}" ] \
            || die "refusing to start: the profile target cannot remove the pointer ${pointer}:
${blocker}"
        done <<EOF
$(profile_pointer_files)
EOF
        while IFS= read -r root; do
          [ -n "${root}" ] || continue
          refuse_profile_path "${root}"
          # Absence has to be proven, not assumed. An unsearchable ancestor makes
          # both existence tests false, so a profile that is really there reads as
          # absent and is skipped — while another root is deleted and the run
          # exits 0. `first_uninspectable` stays silent for a genuinely absent
          # path, so this only refuses when the answer is unknowable.
          blocker="$(first_uninspectable "${root}")"
          [ -z "${blocker}" ] \
            || die "refusing to start: the profile target cannot inspect ${blocker}"
          [ -e "${root}" ] || [ -L "${root}" ] || continue
          # Same alias resolution `remove_profile` performs: the tree `rm -rf`
          # walks is the symlink's target, and the alias itself is unlinked after
          # it — so both have to be removable, and the target has to clear the
          # overlap refusal on its own name.
          if [ -L "${root}" ] && [ -d "${root}" ]; then
            blocker="$(tree_unremovable "${root}")"
            [ -z "${blocker}" ] \
              || die "refusing to start: the profile target cannot remove the alias ${root}:
${blocker}"
            root="$(cd "${root}" && pwd -P)"
            refuse_profile_path "${root}"
          fi
          blocker="$(tree_unremovable "${root}")"
          [ -z "${blocker}" ] \
            || die "refusing to start: the profile target cannot remove ${root}:
${blocker}"
        done <<EOF
$(profile_delete_candidates)
EOF
        ;;
    esac
  done
}

# unwritable_roots ROOTS TARGET — die when an existing skills root cannot be
# inspected or written. Unlinking a skill removes an entry from its directory,
# so a readable but unwritable root fails at removal time — after `profile` has
# already run and while the channel still reports "Uninstall completed". An
# unsearchable root hides children as "missing" and must refuse the same way.
unwritable_roots() {
  local roots="$1" target="$2" root blocker
  while IFS= read -r root; do
    [ -n "${root}" ] || continue
    blocker="$(first_uninspectable "${root}")"
    [ -z "${blocker}" ] \
      || die "refusing to start: the ${target} target cannot inspect ${blocker}"
    [ -d "${root}" ] || continue
    [ -w "${root}" ] \
      || die "refusing to start: the ${target} target cannot unlink from ${root} (not writable)"
  done <<EOF
${roots}
EOF
}

# unremovable_skill_entries ROOTS TARGET — die when a kit skill entry this
# channel will unlink cannot be removed from a sticky directory this user does
# not own. `-w` on mode 1777 is true for any user, but sticky only allows
# unlinking own entries; without this check, `profile agents` can delete the
# profile and then fail mid-channel while still printing "Uninstall completed".
unremovable_skill_entries() {
  local roots="$1" target="$2" root dest name euid names
  euid="$(id -u)"
  # Root is not bound by sticky-directory ownership rules.
  [ "${euid}" -eq 0 ] && return 0
  # Resolve names with if/elif, not `case` inside `$(...)` — macOS Bash 3.2
  # misparses multi-arm case in command substitutions.
  if [ "${target}" = agents ]; then
    # shellcheck source=agents/lib.sh
    . "${REPO_ROOT}/scripts/agents/lib.sh"
    names="${SKILL_NAMES} ${LEGACY_SKILL_NAMES}"
  elif [ "${target}" = browser-use ]; then
    # Its own set, not the union: refusing on an agents-channel link this target
    # will never unlink would block a run that was always going to succeed.
    # shellcheck source=agents/lib.sh
    . "${REPO_ROOT}/scripts/agents/lib.sh"
    names="${BROWSER_SKILL_NAMES} ${BROWSER_SHARED_DEPS} browser-use"
  elif [ "${target}" = aside ]; then
    # shellcheck source=aside/lib.sh
    . "${REPO_ROOT}/scripts/aside/lib.sh"
    names="${SKILL_NAMES} ${LEGACY_SKILL_NAMES}"
  else
    die "internal error: unremovable_skill_entries unknown target: ${target}"
  fi
  while IFS= read -r root; do
    [ -n "${root}" ] || continue
    [ -d "${root}" ] || continue
    # Only sticky roots this user does not own create the false `-w` pass.
    [ -k "${root}" ] || continue
    [ ! -O "${root}" ] || continue
    for name in ${names}; do
      dest="${root}/${name}"
      [ -e "${dest}" ] || [ -L "${dest}" ] || continue
      if [ "${target}" = agents ]; then
        case " ${BROWSER_SHARED_DEPS} " in
          *" ${name} "*)
            for n in ${BROWSER_SKILL_NAMES}; do
              if is_kit_skill_link "$(skill_dest "${root}" "${n}")" "${REPO_ROOT}" "${n}"; then
                continue 2
              fi
            done
            ;;
        esac
      fi
      if [ "${target}" = browser-use ]; then
        case " ${BROWSER_SHARED_DEPS} " in
          *" ${name} "*)
            case " ${SKILL_NAMES} " in
              *" ${name} "*)
                case " ${UNINSTALL_TARGETS} " in
                  *" agents "*) ;;
                  *)
                    for n in job-stories job-inbox; do
                      if is_kit_skill_link "$(skill_dest "${root}" "${n}")" "${REPO_ROOT}" "${n}"; then
                        continue 2
                      fi
                    done
                    ;;
                esac
                ;;
            esac
            ;;
        esac
      fi
      # Foreign-owned entry in sticky root: this user cannot unlink it.
      [ -O "${dest}" ] \
        || die "refusing to start: the ${target} target cannot unlink ${dest} (owned by another user inside sticky ${root})"
    done
  done <<EOF
${roots}
EOF
}

# unremovable_copies ROOTS — die when a kit-owned Aside copy cannot be deleted.
# Aside installs marked copies as well as symlinks, and `remove_owned_path`
# removes a copy recursively — so one unwritable directory nested inside it
# aborts the uninstall, after `profile` has already run.
unremovable_copies() {
  local roots="$1" root name dest blocker
  while IFS= read -r root; do
    [ -n "${root}" ] || continue
    [ -d "${root}" ] || continue
    for name in $(
      # shellcheck source=aside/lib.sh
      . "${REPO_ROOT}/scripts/aside/lib.sh"
      printf '%s %s\n' "${SKILL_NAMES}" "${LEGACY_SKILL_NAMES}"
    ); do
      dest="${root}/${name}"
      [ -d "${dest}" ] || continue
      [ ! -L "${dest}" ] || continue
      [ -f "${dest}/.job-kit" ] || continue
      # `is_kit_skill_copy` decides ownership by reading this marker. An
      # unreadable one makes it call a kit copy foreign and skip it, so the
      # channel reports "Uninstall completed" with the copy still installed and
      # `profile` already gone. Unreadable is not absent — refuse instead.
      [ -r "${dest}/.job-kit" ] \
        || die "refusing to start: the aside target cannot read the ownership marker ${dest}/.job-kit"
      blocker="$(tree_unremovable "${dest}")"
      [ -z "${blocker}" ] \
        || die "refusing to start: the aside target cannot remove ${dest}:
${blocker}"
    done
  done <<EOF
${roots}
EOF
}

run_target() {
  case "$1" in
    aside) uninstall_aside ;;
    agents) uninstall_agents ;;
    browser-use) uninstall_browser_use ;;
    profile) remove_profile ;;
    cache) purge_cache ;;
    *) die "unknown target: $1 (aside|agents|browser-use|profile|cache|all)" ;;
  esac
}

# plan_order TARGET… — dedup, and force cache last. `cache` can delete REPO_ROOT
# (purge_cache) and every other target sources its channel library from there —
# browser-use included, so pinning cache last is what orders it before cache.
plan_order() {
  local t has_cache=0 out=""
  for t in "$@"; do
    case "${t}" in
      cache) has_cache=1; continue ;;
    esac
    case " ${out} " in
      *" ${t} "*) continue ;;
    esac
    out="${out}${out:+ }${t}"
  done
  [ "${has_cache}" -eq 0 ] || out="${out}${out:+ }cache"
  printf '%s\n' "${out}"
}

# run_plan TARGET… — the single path every entry point takes.
# Order is the contract: nothing mutates before the plan is on screen, the
# existing preflights still refuse before the prompt, and the prompt is the last
# thing between the user and rm.
run_plan() {
  local ordered rows removals irreversible t
  local seen_aside=0 seen_agents=0 seen_browser=0 has_cache=0 scope=all
  ordered="$(plan_order "$@")"
  [ -n "${ordered}" ] || die "no targets selected"
  UNINSTALL_TARGETS="${ordered}"
  for t in ${ordered}; do
    case "${t}" in
      aside) seen_aside=1 ;;
      agents) seen_agents=1 ;;
      browser-use) seen_browser=1 ;;
      cache) has_cache=1 ;;
    esac
  done

  plan_preflight ${ordered}
  rows=""
  rows="$(build_plan ${ordered})"
  render_plan "${rows}"
  removals="$(plan_count "${rows}" I X)"
  irreversible="$(plan_count "${rows}" X)"
  printf '%s removals · %s irreversible\n' "${removals}" "${irreversible}"
  echo

  preflight_targets ${ordered}
  if [ "${has_cache}" -eq 1 ]; then
    # browser-use joins the test: the survivor scan now enumerates
    # ALL_SKILL_NAMES under an agent home, and only this target unlinks the
    # browser half of that union. Without it, an aside+agents+cache run would
    # exempt roots whose job-scout / job-apply links nothing has removed.
    if [ "${seen_aside}" -eq 1 ] && [ "${seen_agents}" -eq 1 ] && [ "${seen_browser}" -eq 1 ]; then
      scope=survivors
    fi
    purge_preflight "${scope}"
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "--dry-run: nothing has been touched."
    return 0
  fi
  if [ "${removals}" -eq 0 ]; then
    echo "nothing to remove."
    return 0
  fi
  confirm_plan "${removals}" "${irreversible}" || return 1
  echo
  echo "applying"
  for t in ${ordered}; do
    run_target "${t}"
  done
  echo
  printf 'done · %s removals · 0 failed\n' "${removals}"
}

# interactive_menu — bash select when stdin is a TTY.
interactive_menu() {
  local choice
  PS3="Select component to uninstall (number): "
  select choice in \
    "Aside skills" \
    "Coding-agent skills" \
    "browser-use skills + driver" \
    "Profile data (~/.config/job-kit)" \
    "Kit cache (JOB_KIT_HOME)" \
    "All of the above" \
    "Quit"
  do
    # Every branch routes through run_plan, which renders the manifest and runs
    # the same preflights the argument path runs before any removal.
    case "${REPLY}" in
      1) run_plan aside; return 0 ;;
      2) run_plan agents; return 0 ;;
      3) run_plan browser-use; return 0 ;;
      4) run_plan profile; return 0 ;;
      5) run_plan cache; return 0 ;;
      6) run_plan aside agents browser-use profile cache; return 0 ;;
      7) echo "quit"; return 0 ;;
      *) echo "invalid choice" >&2 ;;
    esac
  done
}

main() {
  local -a targets
  targets=()

  # Before any path list is built, and so before any preflight or removal.
  # Every path list here is newline-delimited (`profile_delete_candidates`,
  # `profile_pointer_files`, `home_bases`, the roots passed to `unwritable_roots`)
  # and every consumer reads it one line at a time, so a break inside one value
  # splits into extra roots: `XDG_CONFIG_HOME=$'/victim\n/other'` would make the
  # text before the break its own deletion root, without the `/job-kit` suffix,
  # and `remove_profile` hands it to `rm -rf`.
  refuse_newline HOME "${HOME}"
  refuse_newline XDG_CONFIG_HOME "${XDG_CONFIG_HOME:-}"
  refuse_newline XDG_DATA_HOME "${XDG_DATA_HOME:-}"
  refuse_newline JOB_KIT_HOME "${JOB_KIT_HOME}"
  refuse_newline CLAUDE_SKILLS "${CLAUDE_SKILLS:-}"
  refuse_newline ASIDE_SKILLS "${ASIDE_SKILLS:-}"
  refuse_newline ASIDE_ACCOUNT "${ASIDE_ACCOUNT:-}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --dry-run) DRY_RUN=1 ;;
      aside|agents|browser-use|profile|cache|all)
        targets[${#targets[@]}]="$1"
        ;;
      *)
        die "unknown option or target: $1 (see --help)"
        ;;
    esac
    shift
  done

  if [ "${#targets[@]}" -eq 0 ]; then
    if [ -t 0 ]; then
      interactive_menu
      return 0
    fi
    die "need a target (aside|agents|browser-use|profile|cache|all) when stdin is not a TTY"
  fi

  local t has_all=0
  for t in "${targets[@]}"; do
    [ "${t}" = "all" ] && has_all=1
  done
  if [ "${has_all}" -eq 1 ]; then
    [ "${#targets[@]}" -eq 1 ] \
      || die "'all' cannot be combined with other targets"
    run_plan aside agents browser-use profile cache
    return 0
  fi

  # run_plan owns ordering, preflight and scope for every entry point.
  run_plan "${targets[@]}"
}

main "$@"
