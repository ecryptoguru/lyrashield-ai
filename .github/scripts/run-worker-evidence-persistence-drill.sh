#!/usr/bin/env bash
# Opt-in disposable evidence lifecycle rehearsal. No pulls, builds, published ports or host credentials.
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
guard="$root/.github/scripts/worker-evidence-drill-guard.py"
if [[ ${1:-} != --supervised ]]; then
  if [[ $# -ne 2 || $1 != --fixtures ]]; then
    echo "usage: $0 --fixtures /path/to/hash-listed/strix-final-writer-fixtures-7311" >&2
    exit 2
  fi
  exec python3 -I -B "$guard" supervise "$0" "$2"
fi
shift
[[ $# == 2 && $1 == --fixtures ]]
tmp=${LYRA_DRILL_SCRATCH:?supervised scratch required}
prefix=${LYRA_DRILL_PREFIX:?supervised namespace required}
[[ $prefix =~ ^lyra-ed-[0-9a-f]{16}$ ]]
net="$prefix-private"
driver="$root/.github/scripts/worker-evidence-persistence-drill.mjs"
fixture_io="$root/.github/scripts/worker-evidence-fixture-io.py"
fixtures=$2
# Local input preparation only; refuse drift before creating any Docker resource.
python3 -I -B "$fixture_io" writer "$fixtures" --stage "$tmp/input"
python3 -I -B "$fixture_io" distinct "$root/.github/scripts/fixtures/worker-evidence-distinct" --stage "$tmp/distinct"
DRILL_PHASE_TIMEOUT=30
docker() { python3 -I -B "$guard" bounded "${DRILL_PHASE_TIMEOUT:-30}" docker "$@"; }
worker='ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:0c91d2a9dd91cfaa9a35ed9742aa118015a5deba8af324c1996d95d050442d5d'
postgres='postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab'
redis='redis:7-alpine@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f'
minio='bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20'
# Check everything local before starting even the first service.
for image in "$worker" "$postgres" "$redis" "$minio"; do docker image inspect "$image" >/dev/null; done
product='ed84ce06889e6a9c047db220fcabfa0c643200ad'
engine='3001517530300ca5f602536bfadcbd3c95ad3039'
[[ $(docker image inspect "$worker" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}') == "$product" ]]
[[ $(docker image inspect "$worker" --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}') == "$engine" ]]
# Read the actual VM's Docker overlay free space (not the host's free space); reuse
# the already-pinned/preloaded Redis image, and do not create a volume or network.
label="lyrashield.evidence-drill=$prefix"
touch "$tmp/docker-resources"
docker run --rm --pull never --name "$prefix-space" --label "$label" --network none \
  --read-only --tmpfs /data:ro,size=1m --cap-drop ALL --security-opt no-new-privileges \
  --cpus .1 --memory 48m --pids-limit 16 --user 65534:65534 --entrypoint /bin/df "$redis" -Pk / \
  | python3 -I -B "$guard" space
mkdir "$tmp/proof"
chmod 0777 "$tmp/proof"  # Private under mktemp; only fixture processes see this mounted path.
cat > "$tmp/deny-engine" <<'DENY'
#!/bin/sh
printf 'attempt\n' >>/proof/engine-called
exit 98
DENY
chmod 0555 "$tmp/deny-engine"
docker network create --internal --label "$label" "$net" >/dev/null
[[ $(docker network inspect "$net" --format '{{.Internal}}') == true ]]
common=(--pull never --label "$label" --network "$net" --security-opt no-new-privileges --pids-limit 128)
docker run -d "${common[@]}" --name "$prefix-postgres" --network-alias postgres \
  --cpus .5 --memory 512m --env POSTGRES_USER=lyrashield --env POSTGRES_DB=lyrashield \
  --env POSTGRES_PASSWORD=disposable-only "$postgres" -c max_connections=50 >/dev/null
docker run -d "${common[@]}" --name "$prefix-redis" --network-alias redis --cpus .25 --memory 128m \
  "$redis" redis-server --save '' --appendonly no >/dev/null
docker run -d "${common[@]}" --name "$prefix-s3" --network-alias s3 --cpus .5 --memory 512m \
  --cap-drop ALL --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m \
  --tmpfs /data:rw,nosuid,nodev,mode=1777,size=2g --entrypoint /opt/bitnami/minio/bin/minio \
  --env GOMEMLIMIT=320MiB --env GOMAXPROCS=1 --env MINIO_ROOT_USER=fixture-access-only --env MINIO_ROOT_PASSWORD=fixture-secret-only \
  --env "MINIO_KMS_SECRET_KEY=fixture:$(openssl rand -base64 32)" --env MINIO_BROWSER=off \
  "$minio" server /data --address :9000 >/dev/null
for i in $(seq 1 45); do
  if docker exec "$prefix-postgres" pg_isready -U lyrashield -d lyrashield >/dev/null 2>&1 && \
     docker exec "$prefix-redis" redis-cli ping | grep -qx PONG && \
     docker exec "$prefix-s3" bash -c 'exec 3<>/dev/tcp/127.0.0.1/9000; printf "GET /minio/health/ready HTTP/1.1\r\nHost: s3:9000\r\nConnection: close\r\n\r\n" >&3; read -r line <&3; [[ "$line" == *" 200 "* ]]' >/dev/null 2>&1; then break; fi
  [[ $i -lt 45 ]] || { echo "Disposable services did not become ready" >&2; exit 1; }
  sleep 2
done

pg() { docker exec -i "$prefix-postgres" psql -X -U lyrashield -d lyrashield -v ON_ERROR_STOP=1 "$@"; }
# Use each exact production migration's SQL, in Prisma directory order, against a new database.
# The worker runtime contains the generated client, not the Prisma migration CLI.
git -C "$root" diff --quiet "$product" -- packages/db/prisma/migrations || { echo 'reader migration source mismatch' >&2; exit 1; }
for sql in "$root"/packages/db/prisma/migrations/*/migration.sql; do cat "$sql"; printf '\n'; done | DRILL_PHASE_TIMEOUT=120 pg -q >/dev/null
pg -q < "$root/.github/scripts/disposable-worker-rehearsal-role.sql"
kek=$(openssl rand -base64 32)
run_phase() {
  local phase=$1 bucket=disposable-evidence
  [[ $phase != denied ]] || bucket=deliberately-absent
  DRILL_PHASE_TIMEOUT=150 docker run --rm "${common[@]}" --name "$prefix-worker" --cap-drop ALL --read-only \
    --cpus .75 --memory 768m --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --mount "type=bind,src=$driver,dst=/app/apps/worker/.ci-evidence.mjs,readonly" \
    --mount "type=bind,src=$fixture_io,dst=/app/apps/worker/worker-evidence-fixture-io.py,readonly" \
    --mount "type=bind,src=$tmp/input,dst=/fixtures,readonly" \
    --mount "type=bind,src=$tmp/distinct,dst=/distinct,readonly" \
    --mount "type=bind,src=$tmp/deny-engine,dst=/fixture-bin/drill-engine-denied,readonly" \
    --mount "type=bind,src=$tmp/proof,dst=/proof" \
    --workdir /app/apps/worker --entrypoint /app/apps/worker/node_modules/.bin/tsx \
    --env NODE_ENV=test --env LYRASHIELD_TEST_DB_DISPOSABLE=1 \
    --env DATABASE_URL=postgresql://app_runtime_ci:runtime-ci-only@postgres:5432/lyrashield \
    --env DATABASE_DIRECT_URL=postgresql://lyrashield:disposable-only@postgres:5432/lyrashield \
    --env DATABASE_SYSTEM_URL=postgresql://lyrashield:disposable-only@postgres:5432/lyrashield \
    --env REDIS_URL=redis://redis:6379 --env S3_ENDPOINT=http://s3:9000 --env S3_BUCKET="$bucket" \
    --env S3_REGION=us-east-1 --env S3_ACCESS_KEY=fixture-access-only --env S3_SECRET_KEY=fixture-secret-only \
    --env LYRASHIELD_EVIDENCE_KEK="$kek" --env 'LYRASHIELD_EVIDENCE_KEK_KEYRING={}' \
    --env BETTER_AUTH_SECRET=disposable-auth-only-not-used-for-login-32chars \
    --env BETTER_AUTH_URL=http://127.0.0.1:3100 --env NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100 \
    --env 'POLAR_PRODUCT_IDS={"pro_monthly":"fixture-worker-smoke-pro-monthly"}' \
    --env LYRASHIELD_ENGINE_PATH=/fixture-bin/drill-engine-denied \
    --env LYRASHIELD_PRODUCT_REVISION="$product" --env LYRASHIELD_ENGINE_REVISION="$engine" \
    --env LYRASHIELD_WORKER_IMAGE_DIGEST="${worker##*@}" "$worker" .ci-evidence.mjs "$phase"
}
run_phase init
run_phase denied
run_phase write
# The trigger is private to this database and this scan. Its status transaction is uncommitted;
# the independently committed evidence + result manifest remain visible after process death.
pg -q <<'SQL'
CREATE FUNCTION fixture_terminal_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A backend may finish this statement after its client is killed. Always roll it
  -- back, within the host's 30s DROP TRIGGER deadline.
  PERFORM pg_sleep(12);
  RAISE EXCEPTION 'disposable terminal checkpoint expired';
END $$;
CREATE TRIGGER fixture_terminal_barrier BEFORE UPDATE OF status ON "Scan" FOR EACH ROW
WHEN (OLD.id = 'task5-fix1-reverse-reuse' AND NEW.status = 'COMPLETED')
EXECUTE FUNCTION fixture_terminal_barrier();
SQL
run_phase interrupt &
writer=$!
for i in $(seq 1 90); do
  if [[ $(pg -Atc "SELECT EXISTS (SELECT 1 FROM \"ScanResultManifest\" WHERE \"scanId\"='task5-fix1-reverse-reuse') AND EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep');") == t ]]; then break; fi
  kill -0 "$writer" 2>/dev/null || { echo "worker exited before durable checkpoint" >&2; exit 1; }
  [[ $i -lt 90 ]] || { echo "timeout waiting for durable checkpoint" >&2; exit 1; }
  sleep 1
done
# Exactly one worker lives on this isolated network. Verify original active membership
# and an unexpired lock atomically at the barrier, immediately before terminating it.
lock_ttl=$(docker exec "$prefix-redis" redis-cli --raw EVAL \
  "if redis.call('LPOS',KEYS[1],ARGV[1]) and redis.call('HGET',KEYS[2],'ats')=='1' then return redis.call('PTTL',KEYS[3]) end return -2" \
  3 bull:scans:active bull:scans:task5-fix1-reverse-reuse bull:scans:task5-fix1-reverse-reuse:lock task5-fix1-reverse-reuse)
[[ $lock_ttl =~ ^[0-9]+$ && $lock_ttl -gt 0 && -s "$tmp/proof/checkpoint-job.json" ]] || {
  echo "Original job is not active and locked at manifest checkpoint" >&2; exit 1; }
echo "Original job active at durable checkpoint: task5-fix1-reverse-reuse attemptsStarted=1 lockTTLms=$lock_ttl"
docker kill --signal KILL "$prefix-worker" >/dev/null
set +e; wait "$writer"; rc=$?; set -e
[[ $rc == 137 ]] || { echo "expected killed worker exit 137, got $rc" >&2; exit 1; }
echo "Original checkpoint worker exited $rc"
pg -q -c 'DROP TRIGGER fixture_terminal_barrier ON "Scan"; DROP FUNCTION fixture_terminal_barrier();'
run_phase resume
run_phase corrupt
[[ ! -e "$tmp/proof/engine-called" && ! -e "$tmp/proof/provider-called" ]]
echo "Disposable reader evidence persistence, restart, replay, reconciliation and denial checks passed."
