#!/usr/bin/env bash
set -euo pipefail
# No published ports, host mounts, cloud credentials or production commands.
# The disposable runner shares only the isolated PostgreSQL network namespace.
suffix="$$-${RANDOM}"
network="lyra-empty-state-rehearsal-${suffix}"
database="lyra-empty-state-pg-${suffix}"
cleanup() {
  docker rm -fv "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null
docker run -d --name "$database" --network "$network" \
  --network-alias db.yejmvtgsxniatmjbwplk.supabase.co \
  --env POSTGRES_PASSWORD=disposable-only --env POSTGRES_DB=postgres postgres:17-alpine >/dev/null
ready=false
for attempt in $(seq 1 30); do
  if docker exec "$database" pg_isready -U postgres -d postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
docker run --rm --network "container:$database" \
  --env LYRASHIELD_TEST_DB_DISPOSABLE=1 \
  --env DATABASE_DIRECT_URL='postgresql://postgres:disposable-only@127.0.0.1:5432/postgres' \
  --env DATABASE_URL='postgresql://postgres:disposable-only@127.0.0.1:5432/postgres' \
  --env LYRASHIELD_TRUSTED_FIXTURE_DATABASE_URL='postgresql://postgres:disposable-only@db.yejmvtgsxniatmjbwplk.supabase.co:5432/postgres' \
  --env LYRASHIELD_TRUSTED_FIXTURE_NETWORK=isolated-docker-only \
  --env LYRASHIELD_FIXTURE_NODE_MODULES=/runtime/node_modules \
  lyra-disposable-trusted-v2:local
