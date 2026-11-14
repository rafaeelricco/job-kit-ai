#!/usr/bin/env bash
# Shared installer machinery: plan rows, rendering, confirm, readiness gates.
# Sourced, never executed. Compatible with macOS Bash 3.2.

# Row field separator. Not TAB: TAB is IFS-whitespace, so `read` collapses an
# empty field and shifts the path left into the label.
ROW_FS="$(printf '\037')"
DRY_RUN=0
# Set to 1 once the user agrees to replace foreign paths; apply fns pass it on.
FORCE=0

# die MSG…
# Prints an error to stderr and exits 1.
die() { echo "error: $*" >&2; exit 1; }

# refuse_newline NAME VALUE — die when VALUE carries a line break.
refuse_newline() {
  local name="$1" value="$2"
  case "${value}" in
    *"
"*) die "${name} must not contain a line break" ;;
  esac
}

# path_display PATH — print PATH with $HOME replaced by ~ (display only).
path_display() {
  local p="$1"
  case "${p}" in
    "${HOME}") printf '~\n' ;;
    "${HOME}"/*) printf '~%s\n' "${p#"${HOME}"}" ;;
    *) printf '%s\n' "${p}" ;;
  esac
}

# skill_leaf ROOT PATH — print PATH's single child name when PATH is ROOT/name;
# otherwise print nothing (non-skill / nested / unrelated).
skill_leaf() {
  local root="$1" path="$2" rest
  case "${path}" in
    "${root}"/*)
      rest="${path#"${root}"/}"
      case "${rest}" in
        ""|*/*) return 0 ;;
        *) printf '%s\n' "${rest}" ;;
      esac
      ;;
  esac
}

# plan_count ROWS KIND… — how many rows carry any of KIND.
plan_count() {
  local rows="$1" kind label path want n=0
  shift
  while IFS="${ROW_FS}" read -r kind label path; do
    [ -n "${kind}" ] || continue
    for want in "$@"; do
      [ "${kind}" = "${want}" ] || continue
      n=$((n + 1))
      break
    done
  done <<EOF
${rows}
EOF
  printf '%s\n' "${n}"
}

# plan_paths ROWS LABEL — print the path of every N row carrying LABEL.
plan_paths() {
  local rows="$1" want="$2" kind label path
  while IFS="${ROW_FS}" read -r kind label path; do
    [ "${kind}" = N ] && [ "${label}" = "${want}" ] && printf '%s\n' "${path}"
  done <<EOF
${rows}
EOF
  return 0
}

# is_stale_kit_path DEST NAME
# Exit 0 when DEST is a kit install whose checkout is gone: a symlink, or a
# copy's .job-kit marker, naming */skill/NAME (either separator, since
# PowerShell writes Windows paths) at a path that no longer exists.
# A renamed or moved repo leaves these behind; they refresh, never block.
is_stale_kit_path() {
  local dest="$1" name="$2" target
  if [ -L "${dest}" ]; then
    target="$(readlink "${dest}")"
  elif [ -d "${dest}" ] && [ -f "${dest}/.job-kit" ]; then
    target="$(cat "${dest}/.job-kit")"
  else
    return 1
  fi
  case "${target}" in
    *[/\\]skill[/\\]"${name}") [ ! -e "${target}" ] ;;
    *) return 1 ;;
  esac
}

# render_plan ROWS — print the manifest to stdout (install title).
render_plan() {
  local rows="$1" kind label path
  local section_root="" section_started=0
  local pend_label="" pend_names="" leaf action rest

  flush_pend() {
    [ -n "${pend_label}" ] || return 0
    printf '  %-16s %s\n' "${pend_label}" "${pend_names}"
    pend_label=""
    pend_names=""
  }

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
      case "${lab}" in
        "link"|"relink"|"copy"|"copy (refresh)"|"install driver"|"remove legacy link")
          printf '  %-16s %s\n' "${lab}" "${leaf}"
          return 0
          ;;
      esac
    fi

    printf '  %-16s %s\n' "${lab}" "$(path_display "${p}")"
  }

  echo "job-kit install · plan"
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

# confirm_plan INSTALLS — TTY gate; a pipe applies after the plan.
confirm_plan() {
  local installs="$1" answer
  [ -t 0 ] || return 0
  printf 'Proceed? %s installs. [Y/n] ' "${installs}" >&2
  read -r answer || true
  case "${answer}" in
    ''|y|Y|yes) return 0 ;;
    *) echo "aborted." >&2; return 1 ;;
  esac
}

# confirm_yes PROMPT — require a typed "yes".
confirm_yes() {
  local prompt="$1" answer
  printf '%s' "${prompt}" >&2
  read -r answer || true
  case "${answer}" in
    yes) return 0 ;;
    *)
      echo "aborted (type yes to confirm)." >&2
      return 1
      ;;
  esac
}

# aside_supported
# Exit 0 on macOS, or when ASIDE_SKILLS names the destination outright.
# Aside Browser ships for macOS only; any other host has nowhere to install.
# Side effects: none.
aside_supported() {
  if [ -n "${ASIDE_SKILLS:-}" ]; then
    return 0
  fi
  [ "$(uname -s)" = "Darwin" ]
}

# aside_ready
# Exit 0 when Aside's skills parent exists, or ASIDE_SKILLS is set.
# Side effects: none.
aside_ready() {
  if [ -n "${ASIDE_SKILLS:-}" ]; then
    return 0
  fi
  [ -d "${HOME}/.aside/u/${ASIDE_ACCOUNT:-0}/skills" ]
}

# agents_ready
# Exit 0 when at least one coding-agent home exists, or CLAUDE_SKILLS is set.
# Side effects: none.
agents_ready() {
  if [ -n "${CLAUDE_SKILLS:-}" ]; then
    return 0
  fi
  [ -d "${HOME}/.claude" ] || [ -d "${HOME}/.agents" ] || [ -d "${HOME}/.grok" ] \
    || [ -d "${HOME}/.hermes" ]
}

# run_channel_plan ROWS LABEL APPLY_FN
# The one plan→render→confirm→apply loop every channel installer shares.
# ROWS is a rendered manifest; LABEL names the channel in errors; APPLY_FN is
# the channel's apply function, run only past the gate.
# Side effects: none until APPLY_FN runs; --dry-run never reaches it.
run_channel_plan() {
  local rows="$1" label="$2" apply_fn="$3" installs foreign n
  local has_parent_missing=0 has_up_to_date=0 kind lab path

  [ -d "${REPO_ROOT}/skill" ] \
    || die "not a job-kit checkout (missing skill/): ${REPO_ROOT}"

  render_plan "${rows}"
  installs="$(plan_count "${rows}" I)"
  printf '%s installs\n' "${installs}"
  echo

  if [ -n "$(plan_paths "${rows}" "source missing")" ]; then
    die "plan has missing skill sources; this checkout is incomplete (see plan)"
  fi

  foreign="$(plan_paths "${rows}" foreign)"
  if [ -n "${foreign}" ]; then
    n="$(printf '%s\n' "${foreign}" | wc -l | tr -d ' ')"
    echo "${n} foreign paths block the install (not made by job-kit). To clear them:"
    printf '  rm -rf'
    while IFS= read -r path; do printf ' %q' "${path}"; done <<EOF
${foreign}
EOF
    printf '\n\n'
    if [ "${DRY_RUN}" -eq 1 ] || [ ! -t 0 ] \
      || ! confirm_yes "Replace them with kit copies now? Type yes to confirm: "; then
      die "${label}: foreign paths at the destination; remove them (command above) and re-run"
    fi
    FORCE=1
    installs=$((installs + n))
  fi

  if [ "${DRY_RUN}" -eq 1 ]; then
    echo "--dry-run: nothing has been touched."
    return 0
  fi

  if [ "${installs}" -eq 0 ]; then
    while IFS="${ROW_FS}" read -r kind lab path; do
      [ -n "${kind}" ] || continue
      case "${lab}" in
        "parent missing") has_parent_missing=1 ;;
        "up to date") has_up_to_date=1 ;;
      esac
    done <<EOF
${rows}
EOF
    if [ "${has_parent_missing}" -eq 1 ] && [ "${has_up_to_date}" -eq 0 ]; then
      die "${label}: nothing to install: required parent directories are missing (see plan)"
    fi
    echo "nothing to install."
    return 0
  fi

  confirm_plan "${installs}" || return 1
  echo
  echo "applying"
  "${apply_fn}" || return 1
  echo
  printf 'done · %s installs · 0 failed\n' "${installs}"
}
