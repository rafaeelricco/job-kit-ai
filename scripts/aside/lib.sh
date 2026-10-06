#!/usr/bin/env bash
# Shared helpers for Aside skill install/uninstall.
# Compatible with macOS Bash 3.2. Source only — do not execute.

# Skill folder names under skill/ that Aside may load (Aside channel only).
CORE_SKILL_NAMES="job-profile-root job-store"
SKILL_NAMES="job-scout job-apply job-prep job-resume-refine job-resume-review job-profile job-list job-match job-stories job-inbox job-humanize ${CORE_SKILL_NAMES}"
# Prior Aside basenames from this kit; install/uninstall may remove orphans.
# Predicates: kit symlink OR kit copy (.job-kit marker). Source dir need not exist for legacy links.
LEGACY_SKILL_NAMES="job-discovery job-application profile-scaffold application-stage profile-init job-profile-config job-tracker job-resume job-profile-me job-pitch"

# Marker written at DEST/.job-kit so uninstall can tell kit copies from foreign dirs.
KIT_MARKER=".job-kit"

# resolve_repo_root
# Prints absolute job-kit root (parent of scripts/).
# Args: none. Uses BASH_SOURCE[1] (the script that sourced this file).
# Side effects: none. Prints error and returns 1 if layout is wrong.
resolve_repo_root() {
  local entry entry_dir scripts_dir repo
  entry="${BASH_SOURCE[1]:-}"
  [ -n "${entry}" ] || {
    echo "error: resolve_repo_root must be called from a sourced entry script" >&2
    return 1
  }
  case "${entry}" in
    /*) ;;
    *) entry="$(pwd -P)/${entry}" ;;
  esac
  [ -f "${entry}" ] || {
    echo "error: entry script not found: ${entry}" >&2
    return 1
  }
  entry_dir="$(cd "$(dirname "${entry}")" && pwd -P)"
  scripts_dir="$(cd "${entry_dir}/.." && pwd -P)"
  repo="$(cd "${scripts_dir}/.." && pwd -P)"
  [ -d "${repo}/skill" ] || {
    echo "error: not a job-kit checkout (missing skill/): ${repo}" >&2
    return 1
  }
  [ -d "${repo}/scripts/aside" ] || {
    echo "error: not a job-kit checkout (missing scripts/aside/): ${repo}" >&2
    return 1
  }
  printf '%s\n' "${repo}"
}

# resolve_aside_skills_root
# Prints Aside skills directory for this channel.
# Default: $HOME/.aside/u/0/skills/builtin
# Override: absolute ASIDE_SKILLS, or ASIDE_ACCOUNT for u/<id>.
# Side effects: none.
resolve_aside_skills_root() {
  local account path override
  override="${ASIDE_SKILLS:-}"
  if [ -n "${override}" ]; then
    case "${override}" in
      /*) printf '%s\n' "${override}" ;;
      *)
        echo "error: ASIDE_SKILLS must be an absolute path" >&2
        return 1
        ;;
    esac
    return 0
  fi
  account="${ASIDE_ACCOUNT:-0}"
  path="${HOME}/.aside/u/${account}/skills/builtin"
  printf '%s\n' "${path}"
}

# skill_source REPO NAME
# Prints absolute path to skill/<NAME> under REPO.
# Side effects: none.
skill_source() {
  local repo="$1" name="$2"
  printf '%s/skill/%s\n' "${repo}" "${name}"
}

# skill_dest ROOT NAME
# Prints absolute path ROOT/NAME.
# Side effects: none.
skill_dest() {
  local root="$1" name="$2"
  printf '%s/%s\n' "${root}" "${name}"
}

# is_exact_link DEST SOURCE
# Exit 0 if DEST is a symlink whose readlink equals SOURCE.
# Side effects: none.
is_exact_link() {
  local dest="$1" source="$2" current
  [ -L "${dest}" ] || return 1
  current="$(readlink "${dest}")"
  [ "${current}" = "${source}" ]
}

# is_kit_skill_link DEST REPO NAME
# Exit 0 if DEST is a symlink to REPO/skill/NAME.
# Side effects: none.
is_kit_skill_link() {
  local dest="$1" repo="$2" name="$3" expected current
  [ -L "${dest}" ] || return 1
  expected="$(skill_source "${repo}" "${name}")"
  current="$(readlink "${dest}")"
  [ "${current}" = "${expected}" ]
}

# is_kit_skill_copy DEST REPO NAME
# Exit 0 if DEST is a real directory with .job-kit marker pointing at REPO/skill/NAME.
# Side effects: none.
is_kit_skill_copy() {
  local dest="$1" repo="$2" name="$3" marker expected
  [ -d "${dest}" ] || return 1
  [ ! -L "${dest}" ] || return 1
  marker="${dest}/${KIT_MARKER}"
  [ -f "${marker}" ] || return 1
  expected="$(skill_source "${repo}" "${name}")"
  [ "$(cat "${marker}")" = "${expected}" ]
}

# is_kit_owned DEST REPO NAME
# Exit 0 if DEST is a kit symlink or a kit-marked copy for NAME.
# Side effects: none.
is_kit_owned() {
  is_kit_skill_link "$@" || is_kit_skill_copy "$@"
}

# remove_owned_path DEST
# Removes DEST when it is a symlink/file (rm -f) or directory (rm -rf).
# Side effects: may rm. Prints error and returns 1 on failure.
remove_owned_path() {
  local dest="$1"
  if [ -L "${dest}" ] || [ -f "${dest}" ]; then
    rm -f "${dest}" || {
      echo "error: failed to remove: ${dest}" >&2
      return 1
    }
  else
    rm -rf "${dest}" || {
      echo "error: failed to remove: ${dest}" >&2
      return 1
    }
  fi
}

# unlink_legacy_skills DEST_ROOT REPO [NAMES]
# Removes DEST_ROOT/<legacy> when kit-owned (old symlink or marked copy).
# NAMES defaults to LEGACY_SKILL_NAMES.
# Source dir need not exist (post-rename orphans). Prints status lines.
# Side effects: may rm kit-owned legacy paths. Does not touch foreign paths.
unlink_legacy_skills() {
  local dest_root="$1" repo="$2" names="${3:-${LEGACY_SKILL_NAMES}}" name dest
  for name in ${names}; do
    dest="$(skill_dest "${dest_root}" "${name}")"
    if [ ! -e "${dest}" ] && [ ! -L "${dest}" ]; then
      continue
    fi
    if is_kit_owned "${dest}" "${repo}" "${name}"; then
      remove_owned_path "${dest}" || return 1
      echo "removed legacy: ${dest}"
    fi
  done
}

# ensure_aside_skills_root DEST_ROOT
# Creates DEST_ROOT only if its parent already exists (Aside already set up).
# Side effects: may mkdir DEST_ROOT. Returns 1 if parent is missing.
ensure_aside_skills_root() {
  local dest_root="$1" parent
  parent="$(dirname "${dest_root}")"
  if [ -d "${dest_root}" ]; then
    return 0
  fi
  if [ ! -d "${parent}" ]; then
    echo "error: Aside skills parent missing: ${parent}" >&2
    echo "  Install Aside Browser and sign in first (expected under ~/.aside)." >&2
    return 1
  fi
  mkdir -p "${dest_root}" || {
    echo "error: failed to create: ${dest_root}" >&2
    return 1
  }
}

# install_skills_into DEST_ROOT REPO FORCE
# Copies every SKILL_NAMES entry into DEST_ROOT; then unlinks legacy names there.
# Side effects: may mkdir, copy trees, remove kit-owned legacy paths.
install_skills_into() {
  local dest_root="$1" repo="$2" force="$3" name source dest
  ensure_aside_skills_root "${dest_root}" || return 1
  for name in ${SKILL_NAMES}; do
    source="$(skill_source "${repo}" "${name}")"
    dest="$(skill_dest "${dest_root}" "${name}")"
    copy_skill "${source}" "${dest}" "${force}" "${repo}" || return 1
  done
  unlink_legacy_skills "${dest_root}" "${repo}" || return 1
}

# require_skill_source SOURCE
# Exit 0 if SOURCE is a skill directory with SKILL.md.
# Side effects: none. Prints error and returns 1 if missing.
require_skill_source() {
  local source="$1"
  [ -d "${source}" ] || {
    echo "error: skill source missing: ${source}" >&2
    return 1
  }
  [ -f "${source}/SKILL.md" ] || {
    echo "error: skill missing SKILL.md: ${source}" >&2
    return 1
  }
}

# copy_skill SOURCE DEST FORCE REPO
# Full-tree copy. Kit-owned dest or old kit link → replace. Foreign → fail unless FORCE=1.
# Never leaves a symlink at DEST. Writes DEST/.job-kit with SOURCE path.
# Stages under a temp sibling + marker, then replaces dest so a failed cp cannot wipe a working install.
# Side effects: may mv/rm + cp -R. Prints status lines.
copy_skill() {
  local source="$1" dest="$2" force="$3" repo="$4" parent name tmp bak
  require_skill_source "${source}" || return 1

  parent="$(dirname "${dest}")"
  name="$(basename "${dest}")"
  [ -d "${parent}" ] || {
    echo "error: destination parent missing: ${parent}" >&2
    return 1
  }
  dest="$(cd "${parent}" && pwd -P)/${name}"
  parent="$(dirname "${dest}")"

  if [ -L "${dest}" ] || [ -e "${dest}" ]; then
    if is_kit_owned "${dest}" "${repo}" "${name}" || is_exact_link "${dest}" "${source}" \
      || is_stale_kit_path "${dest}" "${name}"; then
      :
    elif [ "${force}" -eq 1 ]; then
      echo "forced remove: ${dest}"
    else
      echo "error: foreign path blocks install: ${dest}" >&2
      echo "  remove it manually, then re-run" >&2
      return 1
    fi
  fi

  tmp="${parent}/.${name}.job-kit.$$"
  bak="${parent}/.${name}.job-kit-bak.$$"
  rm -rf "${tmp}" "${bak}"
  cp -R "${source}" "${tmp}" || {
    echo "error: failed to copy ${source} -> ${tmp}" >&2
    return 1
  }
  printf '%s\n' "${source}" > "${tmp}/${KIT_MARKER}" || {
    rm -rf "${tmp}"
    echo "error: failed to write marker: ${tmp}/${KIT_MARKER}" >&2
    return 1
  }

  if [ -L "${dest}" ] || [ -e "${dest}" ]; then
    mv "${dest}" "${bak}" || {
      rm -rf "${tmp}"
      echo "error: failed to move aside: ${dest}" >&2
      return 1
    }
    if ! mv "${tmp}" "${dest}"; then
      mv "${bak}" "${dest}" 2>/dev/null || true
      rm -rf "${tmp}"
      echo "error: failed to replace ${dest}" >&2
      return 1
    fi
    rm -rf "${bak}"
  else
    mv "${tmp}" "${dest}" || {
      rm -rf "${tmp}"
      echo "error: failed to install ${dest}" >&2
      return 1
    }
  fi
  echo "copied: ${source} -> ${dest}"
}

# unlink_skill DEST REPO NAME
# Removes DEST only when kit-owned (symlink or marked copy) for NAME.
# Side effects: may rm. Prints removed/skipped.
unlink_skill() {
  local dest="$1" repo="$2" name="$3"
  if [ ! -e "${dest}" ] && [ ! -L "${dest}" ]; then
    echo "skipped (missing): ${dest}"
    return 0
  fi
  if ! is_kit_owned "${dest}" "${repo}" "${name}"; then
    echo "skipped (not kit-owned): ${dest}"
    return 0
  fi
  remove_owned_path "${dest}" || return 1
  echo "removed: ${dest}"
}

# remove_legacy_user_skills REPO [DEST_ROOT] [NAMES] [LEGACY]
# Drop kit-owned SKILL_NAMES + LEGACY under ~/.aside/u/<account>/skills/user
# so reinstall does not leave stale user/ trees after the channel moves to builtin.
# When DEST_ROOT is the same physical path as skills/user, only remove LEGACY basenames
# (do not delete current SKILL_NAMES just installed there via ASIDE_SKILLS override).
# Side effects: may rm kit-owned paths under skills/user.
# NAMES (optional, 3rd arg) narrows the current-name sweep.
remove_legacy_user_skills() {
  local repo="$1" dest_root="${2:-}" names="${3:-${SKILL_NAMES}}"
  local account="${ASIDE_ACCOUNT:-0}" user_root name dest
  local user_phys dest_phys
  user_root="${HOME}/.aside/u/${account}/skills/user"
  [ -d "${user_root}" ] || return 0
  user_phys="$(cd "${user_root}" && pwd -P)"
  if [ -n "${dest_root}" ] && [ -d "${dest_root}" ]; then
    dest_phys="$(cd "${dest_root}" && pwd -P)"
    if [ "${user_phys}" = "${dest_phys}" ]; then
      unlink_legacy_skills "${user_root}" "${repo}" "${LEGACY_SKILL_NAMES}" || return 1
      echo "skipped user skill migration: install dest is ${user_phys}"
      return 0
    fi
  fi
  unlink_legacy_skills "${user_root}" "${repo}" "${LEGACY_SKILL_NAMES}" || return 1
  for name in ${names}; do
    dest="$(skill_dest "${user_root}" "${name}")"
    unlink_skill "${dest}" "${repo}" "${name}" || return 1
  done
}
