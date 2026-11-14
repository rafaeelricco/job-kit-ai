#!/usr/bin/env bash
# Browser channel installer: browser skills + the browser-use driver skill into
# coding-agent homes. Compatible with macOS Bash 3.2.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
# shellcheck source=../common.sh
. "${REPO_ROOT}/scripts/common.sh"
# shellcheck source=../agents/lib.sh
. "${REPO_ROOT}/scripts/agents/lib.sh"

# usage — CLI help.
usage() {
  cat <<'EOF'
Install job-kit browser skills plus the browser-use driver skill (symlinks into
every agent home present).

Usage: browser-use/install.sh [--dry-run]
       browser-use/install.sh -h|--help

Options:
  --dry-run   Print the plan, link nothing
  -h, --help  Show this help

Homes: ~/.claude, ~/.agents, ~/.grok, ~/.hermes. Every one that exists is
installed; a missing home is skipped, not an error. Missing requirements (the
browser-use CLI, a Chromium-family browser, the driver skill) are named before
the plan and offered on a TTY; they never block.

Every run prints a plan first. On a TTY, confirm with [Y/n]; a pipe applies
after the plan. A foreign destination fails and names the path — remove it and
re-run.

Environment:
  CLAUDE_SKILLS  Absolute skills directory — single dest only (escape hatch)
EOF
}

# have_chromium — 0 when a browser-harness-discoverable browser is installed.
# Args: none. Side effects: none (probes app bundles and PATH only).
have_chromium() {
  local app
  for app in "Google Chrome" "Google Chrome Canary" "Chromium" "Brave Browser" \
    "Microsoft Edge" "Arc" "Comet" "Dia"; do
    if [ -d "/Applications/${app}.app" ]; then return 0; fi
    if [ -d "${HOME}/Applications/${app}.app" ]; then return 0; fi
  done
  command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1
}

# plan_row_agent DEST NAME SOURCE — one browser skill row (symlink).
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

# plan_row_driver ROOT — driver skill dest under a skills root this channel
# installs into. Present → N up to date. Missing + CLI → I (apply runs the
# official installer). Missing + no CLI → N (preflight still names the command).
# Args: ROOT skills directory. Side effects: none.
plan_row_driver() {
  local dest="${1}/browser-use"
  if [ -e "${dest}" ] || [ -L "${dest}" ]; then
    printf 'N%sup to date%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
    return 0
  fi
  if command -v browser-use >/dev/null 2>&1; then
    printf 'I%sinstall driver%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  else
    printf 'N%smissing driver%s%s\n' "${ROW_FS}" "${ROW_FS}" "${dest}"
  fi
}

# browser_use_driver_cmd ROOT — official CLI that writes ROOT/browser-use.
# claude → --target claude; codex (job-kit: ~/.agents/skills) → --target agents;
# anything else (Grok, Hermes, CLAUDE_SKILLS) → --path ROOT/browser-use.
# --no-install: place the skill file only; never uv-upgrade the CLI.
browser_use_driver_cmd() {
  local root="$1"
  if [ "${root}" = "${HOME}/.claude/skills" ]; then
    printf '%s\n' "browser-use skill install --target claude --no-install"
  elif [ "${root}" = "${HOME}/.agents/skills" ]; then
    printf '%s\n' "browser-use skill install --target agents --no-install"
  else
    printf 'browser-use skill install --path "%s" --no-install\n' "${root}/browser-use"
  fi
}

# browser_use_missing_drivers — dests this channel installs into that
# carry no driver skill. Args: none; prints one `PATH<ROW_FS>FIX` row per gap.
# PATH is the driver path in display form; FIX is always a runnable
# `browser-use skill install`. When CLAUDE_SKILLS is set, that dest is
# exclusive (same as install_browser_home) and AGENT_TARGETS are not walked.
# A dest the kit does not install into is skipped: a driver missing there is
# not a gap this channel can close.
browser_use_missing_drivers() {
  (
    local target root override
    override="$(resolve_override_skills)" || exit 1
    if [ -n "${override}" ]; then
      [ -e "${override}/browser-use" ] || [ -L "${override}/browser-use" ] \
        || printf '%s%s%s\n' "$(path_display "${override}/browser-use")" "${ROW_FS}" "$(browser_use_driver_cmd "${override}")"
      exit 0
    fi
    for target in ${AGENT_TARGETS}; do
      root="$(agent_skills_root "${target}")"
      [ -d "$(agent_parent_dir "${target}")" ] || [ -d "${root}" ] || continue
      [ -e "${root}/browser-use" ] || [ -L "${root}/browser-use" ] \
        || printf '%s%s%s\n' "$(path_display "${root}/browser-use")" "${ROW_FS}" "$(browser_use_driver_cmd "${root}")"
    done
  )
}

# browser_use_offer LABEL COMMAND — flag one missing requirement, offer to run it.
# COMMAND is a fixed literal from the caller below — at most an install target
# from a closed two-value map — never operator input.
# Prints the flag always; prompts only on a TTY. A pipe never auto-installs the
# CLI or a browser (third-party tools). The driver skill is a planned I-row
# in apply, not an offer.
browser_use_offer() {
  local label="$1" cmd="$2" reply
  echo "  missing: ${label}"
  echo "    fix: ${cmd}"
  [ -t 0 ] || return 0
  printf '    run it now? [y/N] ' >&2
  read -r reply || true
  case "${reply}" in
    y|Y|yes|YES)
      eval "${cmd}" || echo "    failed, run it yourself: ${cmd}" >&2 ;;
  esac
}

# browser_use_preflight — flag every missing browser-use requirement + offer fixes.
# Args: none. Side effects: may run one offered install command per yes answer.
# Never blocks: the skills install regardless, and each browser skill's Phase 0
# STOPs on its own when no driver answers.
browser_use_preflight() {
  local need_cli=0 need_browser=0 drivers driver_path driver_fix
  command -v browser-use >/dev/null 2>&1 || need_cli=1
  have_chromium || need_browser=1
  # Probed separately: a CLI and a browser that are both already present say
  # nothing about the driver skill, and every browser skill's Phase 0 needs it.
  drivers="$(browser_use_missing_drivers)"
  [ "${need_cli}" -eq 1 ] || [ "${need_browser}" -eq 1 ] || [ -n "${drivers}" ] || return 0

  echo
  echo "browser-use · requirements not met"
  if [ "${need_cli}" -eq 1 ]; then
    if command -v uv >/dev/null 2>&1; then
      browser_use_offer "browser-use CLI" "uv tool install --python 3.12 browser-use"
    elif command -v brew >/dev/null 2>&1; then
      browser_use_offer "uv (needed to install browser-use)" "brew install uv"
    else
      echo "  missing: browser-use CLI"
      echo "    fix: install uv (https://docs.astral.sh/uv/), then:"
      echo "         uv tool install --python 3.12 browser-use"
    fi
  fi
  if [ "${need_browser}" -eq 1 ]; then
    if command -v brew >/dev/null 2>&1; then
      browser_use_offer "a Chromium-family browser" "brew install --cask google-chrome"
    else
      echo "  missing: a Chromium-family browser"
      echo "    fix: install Google Chrome (https://www.google.com/chrome/)"
    fi
  fi
  if [ -n "${drivers}" ]; then
    while IFS="${ROW_FS}" read -r driver_path driver_fix; do
      [ -n "${driver_path}" ] || continue
      if command -v browser-use >/dev/null 2>&1; then
        browser_use_offer "browser-use driver skill (${driver_path})" "${driver_fix}"
      else
        echo "  missing: browser-use driver skill (${driver_path})"
        echo "    fix: ${driver_fix}"
      fi
    done <<EOF
${drivers}
EOF
  fi
  echo
}

# browser_use_connect_note — how an agent reaches Chrome. Printed after every
# non-dry run: preflight returns early once requirements are met.
# Args: none. Side effects: none.
browser_use_connect_note() {
  echo
  echo "browser-use · connect to Chrome"
  echo "  Recommended: a dedicated automation Chrome. Agents in sandboxed apps"
  echo "  cannot read your everyday Chrome's debug port on macOS."
  echo "    bash \"${REPO_ROOT}/scripts/browser-use/chrome.sh\""
  echo "  Sign in there to the sites you use, and set in your agent's env:"
  echo "    BU_CDP_URL=http://127.0.0.1:9333"
  echo "  Or use your everyday Chrome: open chrome://inspect/#remote-debugging and"
  echo "  tick 'Allow remote debugging'."
  echo "  If that Chrome fails with 'Operation not permitted' on"
  echo "  DevToolsActivePort, macOS TCC is blocking it — use the dedicated"
  echo "  Chrome above; mac-approve cannot fix it."
}

# install_driver_into ROOT — write ROOT/browser-use via the official CLI.
# No-op if dest exists or CLI missing (preflight names the command).
# claude/codex use --target; Grok, Hermes, and CLAUDE_SKILLS use --path.
install_driver_into() {
  local root="$1" dest="${1}/browser-use"
  if [ -e "${dest}" ] || [ -L "${dest}" ]; then
    echo "up to date: ${dest}"
    return 0
  fi
  if ! command -v browser-use >/dev/null 2>&1; then
    echo "skipped (no CLI): ${dest}"
    return 0
  fi
  echo "installing driver: ${dest}"
  if [ "${root}" = "${HOME}/.claude/skills" ]; then
    browser-use skill install --target claude --no-install
  elif [ "${root}" = "${HOME}/.agents/skills" ]; then
    browser-use skill install --target agents --no-install
  else
    browser-use skill install --path "${dest}" --no-install
  fi
}

# plan_rows_browser — rows for the browser channel. No mutation.
# Args: none. Side effects: none.
plan_rows_browser() {
  local repo="${REPO_ROOT}" label="browser-use"
  (
    local override target root parent agent_label_s name source dest names
    names="${BROWSER_SKILL_NAMES} ${BROWSER_SHARED_DEPS}"
    # Requirement rows sit under their own header, or they would read as the
    # tail of the preceding section.
    if ! command -v browser-use >/dev/null 2>&1 || ! have_chromium; then
      printf 'H%s%s · requirements%s%s\n' "${ROW_FS}" "${label}" "${ROW_FS}" "offered before install"
      if ! command -v browser-use >/dev/null 2>&1; then
        printf 'N%smissing CLI%s%s\n' "${ROW_FS}" "${ROW_FS}" "uv tool install --python 3.12 browser-use"
      fi
      if ! have_chromium; then
        printf 'N%smissing browser%s%s\n' "${ROW_FS}" "${ROW_FS}" "brew install --cask google-chrome"
      fi
    fi
    override="$(resolve_override_skills)" || exit 1
    if [ -n "${override}" ]; then
      printf 'H%s%s (override)%s%s\n' "${ROW_FS}" "${label}" "${ROW_FS}" "${override}"
      for name in ${names}; do
        source="$(skill_source "${repo}" "${name}")"
        dest="$(skill_dest "${override}" "${name}")"
        plan_row_agent "${dest}" "${name}" "${source}"
      done
      plan_rows_legacy_agent_skills "${override}" "${repo}"
      plan_row_driver "${override}"
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
      for name in ${names}; do
        source="$(skill_source "${repo}" "${name}")"
        dest="$(skill_dest "${root}" "${name}")"
        plan_row_agent "${dest}" "${name}" "${source}"
      done
      plan_rows_legacy_agent_skills "${root}" "${repo}"
      plan_row_driver "${root}"
    done
  )
}

# install_browser_home — apply the browser channel. No plan.
# Args: none. Side effects: mkdir, symlink, driver install, legacy cleanup.
# Needs at least one home installed; zero is an error naming the expected dirs.
install_browser_home() {
  local repo="${REPO_ROOT}"
  (
    local override dest_root target parent agent_label_s linked=0 attempted=0 names
    names="${BROWSER_SKILL_NAMES} ${BROWSER_SHARED_DEPS}"
    override="$(resolve_override_skills)" || exit 1
    if [ -n "${override}" ]; then
      echo "== override (${override}) =="
      install_skills_into "${override}" "${repo}" "${FORCE}" "${names}" || exit 1
      install_driver_into "${override}" || exit 1
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
      if install_skills_into "${dest_root}" "${repo}" "${FORCE}" "${names}"; then
        linked=$((linked + 1))
        install_driver_into "${dest_root}" || exit 1
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

# main ARGS… — parse argv, preflight, plan, gate, apply.
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

  # Requirements first, so the plan reports what the offers already fixed.
  # --dry-run never reaches it: an offer can install a third-party tool.
  [ "${DRY_RUN}" -eq 1 ] || browser_use_preflight

  rows="$(plan_rows_browser)"
  run_channel_plan "${rows}" "browser-use" install_browser_home
  [ "${DRY_RUN}" -eq 1 ] || browser_use_connect_note
}

main "$@"
