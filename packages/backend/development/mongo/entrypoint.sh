#!/usr/bin/env bash
set -euo pipefail
if [ ! -s /data/configdb/mongo.key ]; then
  (umask 077; openssl rand -base64 756 > /data/configdb/mongo.key)
fi
chmod 600 /data/configdb/mongo.key
chown mongodb:mongodb /data/configdb/mongo.key
exec /usr/local/bin/docker-entrypoint.sh "$@"
