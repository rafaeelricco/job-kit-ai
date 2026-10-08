#!/usr/bin/env bash
# Coding-agent channel installer: symlinks kit skills into every agent home.
# Compatible with macOS Bash 3.2. Local checkout only; no clone.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
# shellcheck source=../common.sh
. "${REPO_ROOT}/scripts/common.sh"
# shellcheck source=lib.sh
. "${REPO_ROOT}/scripts/agents/lib.sh"

# usage — CLI help.
usage() {
  cat <<'EOF'
Install job-kit coding-agent skills (symlinks into every agent home present).

Usage: agents/install.sh [--dry-run]
       agents/install.sh -h|--help

Options:
  --dry-run   Print the plan, link nothing
  -h, --help  Show this help

Homes: ~/.claude, ~/.agents, ~/.grok, ~/.hermes. Every one that exists is
installed; a missing home is skipped, not an error.

Every run prints a plan first. On a TTY, confirm with [Y/n]; a pipe applies
after the plan. A foreign destination fails and names the path — remove it and
re-run.

Environment:
  CLAUDE_SKILLS  Absolute skills directory — single dest only (escape hatch)
EOF
}

# plan_row_agent DEST NAME SOURCE — one agents skill row (symlink).
# Args: DEST link path, NAME skill basename, SOURCE skill dir.
# Side effects: none (probes the destination only).
plan_row_agent() {
  local dest="$1" name="$2" source="$3"
  if [ ! -d "${source}" ] || [ ! -f "${source}/SKILL.md" ]; then
    printf 'N%ssource missing%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
    return 0
  fi
  if is_exact_link "${dest}" "${source}"; then
    printf 'N%sup to date%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
    return 0
  fi
  if is_stale_kit_path "${dest}" "${name}"; then
    printf 'I%srelink%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
    return 0
  fi
  if [ -L "${dest}" ] || [ -e "${dest}" ]; then
    printf 'N%sforeign%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
    return 0
  fi
  printf 'I%slink%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
}

# plan_rows_agent_home — rows for every agent home. No mutation.
# Args: none. Side effects: none.
plan_rows_agent_home() {
  local repo="${REPO_ROOT}" label="agents"
  (
    local override target root parent agent_label_s name source dest
    override="$(resolve_override_skills)" || exit 1
    if [ -n "${override}" ]; then
      printf 'H%s%s (override)%s%s\n' "${ROW_FS}" "${label}" "${ROW_FS}" "${override}"
      for name in ${SKILL_NAMES}; do
        source="$(skill_source "${repo}" "${name}")"
        dest="$(skill_dest "${override}" "${name}")"
        plan_row_agent "${dest}" "${name}" "${source}"
      done
      exit 0
    fi
    for target in ${AGENT_TARGETS}; do
      root="$(agent_skills_root "${target}")"
      agent_label_s="$(agent_label "${target}")"
      parent="$(agent_parent_dir "${target}")"
      if [ ! -d "${parent}" ]; then
        printf 'H%s%s · %s%s%s\n' "${ROW_FS}" "${label}" "${agent_label_s}" "${ROW_FS}" "${root}"
        printf 'N%sparent missing%s%s\n' "${ROW_FS}" "${ROW_FS}" "${parent}"
        continue
      fi
      printf 'H%s%s · %s%s%s\n' "${ROW_FS}" "${label}" "${agent_label_s}" "${ROW_FS}" "${root}"
      for name in ${SKILL_NAMES}; do
        source="$(skill_source "${repo}" "${name}")"
        dest="$(skill_dest "${root}" "${name}")"
        plan_row_agent "${dest}" "${name}" "${source}"
      done
    done
  )
}

# install_agent_home — apply the agents channel. No plan.
# Args: none. Side effects: mkdir, symlink, remove kit-owned legacy paths.
# Needs at least one home installed; zero is an error naming the expected dirs.
install_agent_home() {
  local repo="${REPO_ROOT}"
  (
    local override dest_root target parent agent_label_s linked=0 attempted=0
    override="$(resolve_override_skills)" || exit 1
    if [ -n "${override}" ]; then
      echo "== override (${override}) =="
      install_skills_into "${override}" "${repo}" "${FORCE}" "${SKILL_NAMES}" || exit 1
      echo "Install completed -> ${override}"
      exit 0
    fi
    for target in ${AGENT_TARGETS}; do
      parent="$(agent_parent_dir "${target}")"
      dest_root="$(agent_skills_root "${target}")"
      agent_label_s="$(agent_label "${target}")"
      if [ ! -d "${parent}" ]; then
        echo "${agent_label_s}: parent missing (${parent}); skipping."
        continue
      fi
      attempted=$((attempted + 1))
      echo "== ${agent_label_s} (${dest_root}) =="
      if install_skills_into "${dest_root}" "${repo}" "${FORCE}" "${SKILL_NAMES}"; then
        linked=$((linked + 1))
      else
        exit 1
      fi
    done
    remove_legacy_codex_skills_dir "${repo}" || exit 1
    if [ "${linked}" -eq 0 ]; then
      echo "error: no agent targets installed (need parent dirs or CLAUDE_SKILLS)" >&2
      echo "  expected one of: ~/.claude  ~/.agents  ~/.grok  ~/.hermes" >&2
      exit 1
    fi
    echo "Install completed (${linked}/${attempted} targets)"
  )
}

# main ARGS… — parse argv, plan, gate, apply.
main() {
  local rows

  refuse_newline HOME "${HOME}"
  refuse_newline CLAUDE_SKILLS "${CLAUDE_SKILLS:-}"

  case "${HOME}" in
    /*) ;;
    *) die "HOME must be an absolute path (got: ${HOME})" ;;
  esac

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --dry-run) DRY_RUN=1 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done

  rows="$(plan_rows_agent_home)"
  run_channel_plan "${rows}" "Coding agents" install_agent_home
}

main "$@"
