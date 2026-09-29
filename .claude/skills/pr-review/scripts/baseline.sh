#!/bin/sh
# Run pr-review's baseline checks for the areas a PR touches.
#
# Usage:
#   baseline.sh <review tree> < changed-files
#
# Changed paths are repo-relative, one per line. Prints a PASS or FAIL line per
# check with the output lines that carry its counts, plus the tail of the output
# when it failed, then a NOT RUN line per touched area. Every check runs even
# when an earlier one fails; the exit code is non-zero if any failed.
set -u

tree=${1:?usage: baseline.sh <review tree> < changed-files}
cd "$tree" || exit 2
changed=$(cat)
status=0

# Count lines, anywhere in the output: scripts/test.sh stage headings and
# summary, unittest, vitest (above its coverage table), and pyright.
counts='^  [a-z]+ — |^Ran [0-9]+ tests?|^FAILED|^(passed|failed):|Test Files +[0-9]|^ +Tests +[0-9]|[0-9]+ errors?, [0-9]+ warnings?'

touched() {
  printf '%s\n' "$changed" | grep -qE "$1"
}

check() {
  dir=$1
  shift
  if out=$(cd "$dir" && "$@" 2>&1); then
    echo "PASS $dir: $*"
    printf '%s\n' "$out" | grep -E "$counts" | sed 's/^/  /'
  else
    echo "FAIL $dir: $*"
    status=1
    printf '%s\n' "$out" | grep -E "$counts" | sed 's/^/  /'
    printf '%s\n' "$out" | tail -n 40 | sed 's/^/  /'
  fi
}

if touched '^(skill/|scripts/|tests/|package\.json$|pyrightconfig\.json$)'; then
  check . bash scripts/test.sh --fast
  check . pnpm typecheck:release
  echo "NOT RUN root: the scripts/test.sh mutation stage that --fast skips"
fi

exit "$status"
