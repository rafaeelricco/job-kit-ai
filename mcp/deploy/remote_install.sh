#!/bin/sh
# Install one Resume Check release on the VPS. Run as root by deploy.sh.
#
# Usage: remote_install.sh <staged-dir> <release-id>
# Touches only: user resume-check, /opt/resume-check, resume-check.service,
# /etc/nginx/conf.d/resume-check.conf, /etc/nginx/snippets/job-kit-ai.conf,
# one include line in /etc/nginx/sites-available/r1cco.com, and an nginx reload.
set -eu

STAGE=$1
RELEASE=$2
BASE=/opt/resume-check
DEST=$BASE/releases/$RELEASE
SITE=/etc/nginx/sites-available/r1cco.com
INCLUDE_LINE='    include /etc/nginx/snippets/job-kit-ai.conf;'
ANCHOR='include /etc/nginx/snippets/dotfiles.conf;'

say() { echo "remote_install: $*"; }

command -v pdftotext >/dev/null || { say "installing poppler-utils"; apt-get install -y -q poppler-utils; }

if ! id resume-check >/dev/null 2>&1; then
  say "creating user resume-check"
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin resume-check
fi

mkdir -p "$BASE/releases" /etc/resume-check
chmod 755 "$BASE" "$BASE/releases" /etc/resume-check
rm -rf "$DEST"
mv "$STAGE" "$DEST"

say "building virtualenv"
python3 -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install -q --disable-pip-version-check --no-deps --require-hashes -r "$DEST/mcp/requirements.lock"
"$DEST/.venv/bin/python" "$DEST/mcp/build_assets.py" "$DEST/mcp/site"
chown -R root:root "$DEST"
chmod -R a+rX,go-w "$DEST"

say "self-test"
(cd "$DEST/mcp" && "$DEST/.venv/bin/python" -c "
import asyncio, sys
from resume_check import server
r = asyncio.run(server.call_tool('score_resume_review', {'criteria': {'parsing': 4}}))
sys.exit(0 if r.structured_content and r.structured_content['score'] == 100 else 1)")

say "configuring nginx"
LIMITS=/etc/nginx/conf.d/resume-check.conf
SNIPPET=/etc/nginx/snippets/job-kit-ai.conf
BACKUP=$(mktemp -d)
cp "$SITE" "$BACKUP/site"
for f in "$LIMITS" "$SNIPPET"; do [ ! -e "$f" ] || cp "$f" "$BACKUP/$(basename "$f")"; done
restore_nginx() {
  cp "$BACKUP/site" "$SITE"
  for f in "$LIMITS" "$SNIPPET"; do
    if [ -e "$BACKUP/$(basename "$f")" ]; then cp "$BACKUP/$(basename "$f")" "$f"; else rm -f "$f"; fi
  done
}
install -m 644 "$DEST/mcp/deploy/nginx-limits.conf" "$LIMITS"
install -m 644 "$DEST/mcp/deploy/nginx-job-kit-ai.conf" "$SNIPPET"
if ! grep -qF 'snippets/job-kit-ai.conf' "$SITE"; then
  grep -qF "$ANCHOR" "$SITE" || { restore_nginx; say "anchor line not found in $SITE"; exit 1; }
  awk -v anchor="$ANCHOR" -v line="$INCLUDE_LINE" '
    { print }
    index($0, anchor) && !done { print ""; print line; done = 1 }
  ' "$BACKUP/site" > "$SITE"
fi
if ! nginx -t 2>/tmp/resume-check-nginx-test; then
  cat /tmp/resume-check-nginx-test >&2
  say "nginx -t failed; restoring the previous nginx files"
  restore_nginx
  nginx -t
  exit 1
fi
rm -rf "$BACKUP"
systemctl reload nginx

say "switching current -> $RELEASE"
ln -sfn "releases/$RELEASE" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"

install -m 644 "$DEST/mcp/deploy/resume-check.service" /etc/systemd/system/resume-check.service
systemctl daemon-reload
systemctl enable -q resume-check.service
systemctl restart resume-check.service


say "waiting for health check"
i=0
until curl -fsS http://127.0.0.1:3020/healthz >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { journalctl -u resume-check -n 30 --no-pager >&2; exit 1; }
  sleep 1
done

say "pruning old releases"
ls -1 "$BASE/releases" | sort | head -n -3 | while read -r old; do
  [ "releases/$old" = "$(readlink "$BASE/current")" ] || rm -rf "$BASE/releases/$old"
done

say "done: release $RELEASE is live"
