#!/bin/sh
# Deploy Resume Check to the VPS from the committed HEAD of this repository.
#
# Usage: mcp/deploy/deploy.sh [ssh-target]      (default root@r1cco.com)
# Repeatable: each run installs a new release and switches to it in place.
set -eu

TARGET=${1:-root@r1cco.com}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT"

if [ -n "$(git status --porcelain -- mcp skill/job-resume-review)" ]; then
  echo "deploy.sh: commit mcp/ and skill/job-resume-review/ first; the release is built from HEAD" >&2
  exit 1
fi

RELEASE=$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short=12 HEAD)
STAGE=/tmp/resume-check-stage-$RELEASE

echo "deploy.sh: release $RELEASE -> $TARGET"
git archive --format=tar HEAD mcp skill/job-resume-review/scripts skill/job-resume-review/references \
  | ssh "$TARGET" "rm -rf '$STAGE' && mkdir -p '$STAGE' && tar -x -C '$STAGE'"
ssh "$TARGET" "sh '$STAGE/mcp/deploy/remote_install.sh' '$STAGE' '$RELEASE'"
