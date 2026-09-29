#!/bin/sh
# Run the job-kit test pipeline.
#
# Stages, in cost order:
#   unit        shipped script unit tests
#   invariants  cross-component contract consistency
#   golden      recorded CLI contracts
#   lint        distribution and skill-document integrity
#   fuzz        deterministic hostile-input properties
#   mutation    mutation score thresholds
#
# Usage:
#   scripts/test.sh                 every stage
#   scripts/test.sh --fast          skip mutation, the slow stage
#   scripts/test.sh --stress        raise the fuzz budget
#   scripts/test.sh --only fuzz     one stage
#
# Every stage runs even when an earlier one fails; the exit code is non-zero if
# any stage failed, and the summary says which.
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

PYTHONDONTWRITEBYTECODE=1
export PYTHONDONTWRITEBYTECODE

# The skills' own launcher rule, so the pipeline exercises the assumption the
# flows make on an operator's machine.
resolve_python() {
  for candidate in "python3" "py -3" "python"; do
    # shellcheck disable=SC2086
    if major=$($candidate -c 'import sys; print(sys.version_info[0])' 2>/dev/null); then
      if [ "${major}" = "3" ]; then
        echo "${candidate}"
        return 0
      fi
    fi
  done
  return 1
}

PY=$(resolve_python) || {
  echo "test.sh: no python 3 launcher found (tried python3, py -3, python)" >&2
  exit 1
}

FAST=0
STRESS=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) FAST=1 ;;
    --stress) STRESS=1 ;;
    --only)
      shift
      [ $# -gt 0 ] || { echo "test.sh: --only needs a stage name" >&2; exit 2; }
      ONLY="$1"
      ;;
    -h | --help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "test.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

case "${ONLY}" in
  "" | unit | invariants | golden | lint | fuzz | mutation) ;;
  *) echo "test.sh: unknown stage '${ONLY}'" >&2; exit 2 ;;
esac

FAILED=""
PASSED=""

wanted() {
  [ -z "${ONLY}" ] || [ "${ONLY}" = "$1" ]
}

record() {
  if [ "$2" -eq 0 ]; then
    PASSED="${PASSED} $1"
  else
    FAILED="${FAILED} $1"
  fi
}

banner() {
  echo
  echo "=============================================================="
  echo "  $1"
  echo "=============================================================="
}

# discover PATTERN — run one repo-level stage file.
#
# A stage that collects nothing is a failure, not a pass. `unittest discover`
# exits 0 when its pattern matches no file, so a deleted or renamed stage would
# otherwise sail through green — the one thing a test pipeline must never do.
discover() {
  output=$($PY -m unittest discover -s tests -p "$1" 2>&1)
  status=$?
  echo "${output}"
  if echo "${output}" | grep -q "^Ran 0 tests"; then
    echo "test.sh: stage '$1' collected no tests — missing or unmatched file" >&2
    return 1
  fi
  return "${status}"
}

# --- unit ------------------------------------------------------------------
if wanted unit; then
  banner "unit — shipped script unit tests"
  status=0
  for suite in skill/job-match/scripts skill/job-resume-refine/scripts skill/job-store/scripts; do
    echo "--- ${suite}"
    # shellcheck disable=SC2086
    ( cd "${suite}" && $PY -m unittest discover -p 'test_*.py' ) || status=1
  done
  record unit "${status}"
fi

# --- invariants ------------------------------------------------------------
if wanted invariants; then
  banner "invariants — cross-component contract consistency"
  discover 'test_invariants.py'
  record invariants $?
fi

# --- golden ----------------------------------------------------------------
if wanted golden; then
  banner "golden — recorded CLI contracts"
  discover 'test_golden.py'
  record golden $?
fi

# --- lint ------------------------------------------------------------------
if wanted lint; then
  banner "lint — distribution and skill-document integrity"
  status=0
  discover 'test_packaging.py' || status=1
  discover 'test_browser_install.py' || status=1
  discover 'test_release.py' || status=1
  discover 'test_auto_release.py' || status=1
  discover 'test_prose.py' || status=1
  record lint "${status}"
fi

# --- fuzz ------------------------------------------------------------------
if wanted fuzz; then
  banner "fuzz — deterministic hostile-input properties"
  if [ "${STRESS}" -eq 1 ]; then
    # shellcheck disable=SC2086
    $PY tests/fuzz.py --runs 5000
  else
    discover 'test_fuzz.py'
  fi
  record fuzz $?
fi

# --- mutation --------------------------------------------------------------
if wanted mutation; then
  if [ "${FAST}" -eq 1 ]; then
    echo
    echo "mutation: skipped (--fast)"
  else
    banner "mutation — mutation score thresholds"
    # shellcheck disable=SC2086
    $PY tests/mutate.py
    record mutation $?
  fi
fi

# --- summary ---------------------------------------------------------------
banner "summary"
[ -n "${PASSED}" ] && echo "passed:${PASSED}"
if [ -n "${FAILED}" ]; then
  echo "FAILED:${FAILED}"
  exit 1
fi
echo "all stages passed"
exit 0
