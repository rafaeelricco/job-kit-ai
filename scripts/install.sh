#!/usr/bin/env bash
# Single job-kit installer: interactive menu or target args.
# Compatible with macOS Bash 3.2. Local checkout only; no clone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
# shellcheck source=common.sh
. "${REPO_ROOT}/scripts/common.sh"

DRY_RUN_ARGS=""

# usage — CLI help.
usage() {
  cat <<'EOF'
Install job-kit skills (Aside + coding agents). Aside is macOS-only.

Usage: install.sh                 # interactive menu (TTY required)
       install.sh <target>…       # non-interactive (one or more targets)
       install.sh -h|--help

Targets:
  aside        Aside skills — full copy (macOS only)
  agents       Coding-agent skills — symlinks into every agent home present
  browser-use  Browser skills plus the browser-use driver skill
  all          aside + agents + browser-use, skipping absent

Options:
  --dry-run     Print the plan, install nothing
  -h, --help    Show this help

This script only routes: each target runs its own installer, which prints its
own plan and confirms. On a TTY, confirm with [Y/n]; a pipe applies after the
plan. A foreign destination fails and names the path.

  aside        → scripts/aside/install.sh
  agents       → scripts/agents/install.sh
  browser-use  → scripts/browser-use/install.sh

Environment:
  CLAUDE_SKILLS  Absolute skills directory — single dest only (escape hatch).
  ASIDE_SKILLS / ASIDE_ACCOUNT
                 Same overrides as the Aside channel installer
EOF
}

# run_target TARGET
# Execs the channel installer. Never plans, copies, or links itself.
run_target() {
  local script
  case "$1" in
    aside) script="${REPO_ROOT}/scripts/aside/install.sh" ;;
    agents) script="${REPO_ROOT}/scripts/agents/install.sh" ;;
    browser-use) script="${REPO_ROOT}/scripts/browser-use/install.sh" ;;
    *) die "unknown target: $1" ;;
  esac
  # shellcheck disable=SC2086 — DRY_RUN_ARGS is one optional literal flag.
  bash "${script}" ${DRY_RUN_ARGS}
}

# run_all
# Every channel whose parent exists, in order. Absent is a skip, not an error.
run_all() {
  local ran=0
  if ! aside_supported; then
    echo "Aside: macOS-only; skipping."
  elif aside_ready; then
    run_target aside; ran=1
  else
    echo "Aside: not set up (${HOME}/.aside/u/${ASIDE_ACCOUNT:-0}/skills missing); skipping."
  fi
  if agents_ready; then
    run_target agents
    run_target browser-use
    ran=1
  else
    echo "Coding agents: no agent home (~/.claude, ~/.agents, ~/.grok, ~/.hermes); skipping."
  fi
  [ "${ran}" -eq 1 ] || die "nothing installed: no Aside profile and no coding-agent home"
}

# interactive_menu — bash select when stdin is a TTY.
interactive_menu() {
  local choice
  local -a options
  options=()
  if aside_supported; then
    options[${#options[@]}]="Aside skills"
  fi
  options[${#options[@]}]="Coding-agent skills"
  options[${#options[@]}]="browser-use skills (job-company-scout + job-scout + job-apply + job-prep in coding agents)"
  options[${#options[@]}]="All of the above"
  options[${#options[@]}]="Quit"

  PS3="Select component to install (number): "
  select choice in "${options[@]}"; do
    case "${choice}" in
      "Aside skills") run_target aside; return 0 ;;
      "Coding-agent skills") run_target agents; return 0 ;;
      browser-use*) run_target browser-use; return 0 ;;
      "All of the above") run_all; return 0 ;;
      "Quit") echo "quit"; return 0 ;;
      *) echo "invalid choice" >&2 ;;
    esac
  done
}

main() {
  local -a targets
  targets=()

  refuse_newline HOME "${HOME}"
  refuse_newline CLAUDE_SKILLS "${CLAUDE_SKILLS:-}"
  refuse_newline ASIDE_SKILLS "${ASIDE_SKILLS:-}"
  refuse_newline ASIDE_ACCOUNT "${ASIDE_ACCOUNT:-}"

  case "${HOME}" in
    /*) ;;
    *) die "HOME must be an absolute path (got: ${HOME})" ;;
  esac

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit 0 ;;
      --dry-run) DRY_RUN_ARGS="--dry-run" ;;
      aside|agents|browser-use|all)
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
    die "need a target (aside|agents|browser-use|all) when stdin is not a TTY"
  fi

  local t has_all=0
  for t in "${targets[@]}"; do
    [ "${t}" = "all" ] && has_all=1
  done
  if [ "${has_all}" -eq 1 ]; then
    [ "${#targets[@]}" -eq 1 ] \
      || die "'all' cannot be combined with other targets"
    run_all
    return 0
  fi

  for t in "${targets[@]}"; do
    run_target "${t}"
  done
}

main "$@"
