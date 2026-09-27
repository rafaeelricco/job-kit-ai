#!/usr/bin/env bash
set -euo pipefail
mongosh --quiet --host mongo:27017 \
  --username "$MONGO_INITDB_ROOT_USERNAME" \
  --password "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin --eval '
try {
  const status = rs.status();
  quit(status.myState === 1 ? 0 : 1);
} catch (error) {
  if (error.code !== 94) throw error;
  rs.initiate({_id: "rs0", members: [{_id: 0, host: "mongo:27017"}]});
  quit(1);
}'
