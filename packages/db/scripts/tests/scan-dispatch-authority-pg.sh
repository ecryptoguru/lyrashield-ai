#!/usr/bin/env bash
# Owns a disposable network-none PostgreSQL fixture; never accepts a DB URL.
set -euo pipefail
if [[ "$#" -gt 1 ]]; then echo 'Usage: scan-dispatch-authority-pg.sh [--admission-only]' >&2; exit 1; fi
case "${1:-}" in
  '') test_files=(packages/db/src/scan-dispatch-authority-broker.postgres.test.ts packages/db/src/scan-dispatch-admission.postgres.test.ts packages/db/src/scan-queue-outbox.postgres.test.ts) ;;
  --admission-only) test_files=(packages/db/src/scan-dispatch-admission.postgres.test.ts) ;;
  *) echo 'Usage: scan-dispatch-authority-pg.sh [--admission-only]' >&2; exit 1 ;;
esac
repo_root=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$repo_root"
if [[ -n "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}" ]]; then
  echo 'Docker environment overrides are not allowed' >&2; exit 1
fi
context=$(docker context show)
case "$context" in default|desktop-linux) ;; *) echo 'Requires local Docker context' >&2; exit 1;; esac
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
case "$endpoint" in unix:///*) ;; *) echo 'Requires local Unix Docker socket' >&2; exit 1;; esac
image=$(docker image inspect postgres:17-alpine --format '{{.Id}}')
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Local PostgreSQL image required' >&2; exit 1; }
redis_image=$(docker image inspect redis:7-alpine --format '{{.Id}}')
[[ "$redis_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Local Redis image required' >&2; exit 1; }
identity=$(openssl rand -hex 24)
admin_password=$(openssl rand -hex 24)
container=''
relay_pid=''
redis_container=''
redis_relay_pid=''
umask 077
dir=$(mktemp -d "${TMPDIR:-/tmp}/lyra-dispatch-authority.XXXXXXXX")
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=lyrashield_test\n' "$admin_password" > "$dir/postgres.env"
cleanup() {
  local status=$? observed
  trap - EXIT
  if [[ -n "$relay_pid" ]]; then kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true; fi
  if [[ -n "$redis_relay_pid" ]]; then kill "$redis_relay_pid" 2>/dev/null || true; wait "$redis_relay_pid" 2>/dev/null || true; fi
  if [[ -n "$redis_container" ]]; then
    observed=$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}|{{.HostConfig.NetworkMode}}' "$redis_container" 2>/dev/null) || observed=''
    if [[ "$observed" == "$redis_container|$redis_image|$identity|none" ]]; then
      docker rm -f -v "$redis_container" >/dev/null || status=1
    else echo 'Refusing to remove unverified fixture Redis container' >&2; status=1; fi
  fi
  if [[ -n "$container" ]]; then
    observed=$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}|{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null) || observed=''
    if [[ "$observed" == "$container|$image|$identity|none" ]]; then
      docker rm -f -v "$container" >/dev/null || status=1
    else
      echo 'Refusing to remove unverified fixture container' >&2; status=1
    fi
  fi
  if [[ "$status" -ne 0 && -s "$dir/relay.err" ]]; then cat "$dir/relay.err" >&2; fi
  rm -rf "$dir"
  exit "$status"
}
trap cleanup EXIT
redis_password=$(openssl rand -hex 24)
redis_publisher_password=$(openssl rand -hex 24)
printf 'user default on >%s ~* +@all\nuser outbox-publisher on >%s ~bull:scans:* ~lyrashield:scan-workers ~lyrashield:scan-admission:stopped +@all -flushall -flushdb -config -acl -shutdown -debug -module -replicaof -slaveof -migrate -swapdb\n' "$redis_password" "$redis_publisher_password" > "$dir/redis.acl"
printf 'bind 127.0.0.1\nport 6379\nsave ""\nappendonly no\nmaxmemory 128mb\naclfile /run/fixture.acl\n' > "$dir/redis.conf"
redis_container=$(docker create --pull=never --network none --user "$(id -u):$(id -g)" --label "lyrashield.dispatch-authority-fixture=$identity" \
  --mount "type=bind,source=$dir/redis.conf,target=/run/fixture.conf,readonly" \
  --mount "type=bind,source=$dir/redis.acl,target=/run/fixture.acl,readonly" "$redis_image" redis-server /run/fixture.conf)
[[ "$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}|{{.HostConfig.NetworkMode}}' "$redis_container")" == "$redis_container|$redis_image|$identity|none" ]] || exit 1
docker start "$redis_container" >/dev/null
redis_ready=false
for _ in {1..60}; do
  if docker exec -e "REDISCLI_AUTH=$redis_password" "$redis_container" redis-cli ping >/dev/null 2>&1; then redis_ready=true; break; fi
  sleep 0.1
done
[[ "$redis_ready" == true ]] || { echo 'Fixture Redis unavailable' >&2; exit 1; }
python3 "$repo_root/packages/db/scripts/tests/queue-redis-relay.py" "$redis_container" "$dir/redis-port" >"$dir/redis-relay.out" 2>"$dir/redis-relay.err" &
redis_relay_pid=$!
for _ in {1..100}; do
  [[ -s "$dir/redis-port" ]] && break
  kill -0 "$redis_relay_pid" 2>/dev/null || { echo 'Fixture Redis relay unavailable' >&2; exit 1; }
  sleep 0.05
done
redis_port=$(cat "$dir/redis-port")
[[ "$redis_port" =~ ^[0-9]+$ ]] || { echo 'Fixture Redis port unavailable' >&2; exit 1; }
container=$(docker create --pull=never --network none --label "lyrashield.dispatch-authority-fixture=$identity" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m --env-file "$dir/postgres.env" "$image")
[[ "$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}|{{.HostConfig.NetworkMode}}' "$container")" == "$container|$image|$identity|none" ]] || exit 1
docker start "$container" >/dev/null
ready=false
for _ in {1..60}; do
  if docker logs "$container" 2>&1 | grep 'PostgreSQL init process complete' >/dev/null && \
    docker exec "$container" pg_isready -U postgres -d lyrashield_test >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.2
done
if [[ "$ready" != true ]]; then docker logs "$container" >&2 || true; exit 1; fi
python3 "$repo_root/ops/prototypes/dispatch-plan-test/relay.py" "$container" "$dir/port" "$dir/stop-relay" >"$dir/relay.out" 2>"$dir/relay.err" &
relay_pid=$!
for _ in {1..100}; do
  [[ -s "$dir/port" ]] && break
  kill -0 "$relay_pid" 2>/dev/null || { echo 'Fixture relay failed' >&2; exit 1; }
  sleep 0.05
done
port=$(cat "$dir/port")
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'Fixture relay unavailable' >&2; exit 1; }
pnpm db:generate
DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" \
  pnpm --filter @lyrashield/db exec prisma migrate deploy
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test \
  -c 'CREATE DATABASE lyrashield_authority_shadow' >/dev/null
diff_status=0
DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" \
SHADOW_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_authority_shadow" \
  pnpm --filter @lyrashield/db exec prisma migrate diff --exit-code \
    --from-migrations prisma/migrations --to-schema prisma/schema.prisma >"$dir/schema.diff" 2>"$dir/schema.diff.err" || diff_status=$?
if [[ "$diff_status" -ne 0 ]]; then
  cat "$dir/schema.diff" "$dir/schema.diff.err" >&2
  exit 1
fi
runtime_password=$(openssl rand -hex 24)
queue_runtime_password=$(openssl rand -hex 24)
docker exec -i "$container" psql -X -U postgres -d lyrashield_test -v ON_ERROR_STOP=1 <<SQL
-- The runner owns this fixture epoch before either independent suite starts.
INSERT INTO "ScanAuthorityEpoch"
  ("id","epoch","isOpen","openKey","openedAt","closedAt","createdAt","updatedAt")
VALUES ('authority-shared-open-epoch',
  (SELECT coalesce(max("epoch"),0)+1 FROM "ScanAuthorityEpoch"),
  true,'open',CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
CREATE ROLE dispatch_authority_runtime LOGIN PASSWORD '$runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public, app TO dispatch_authority_runtime;
DO \$\$ DECLARE item record; BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT LIKE 'Scan%AUTHORITY%'
    AND tablename NOT IN (
      'PlatformAdminElevation','PlatformAdminChallengeLimit','PlatformAdminAudit',
      'billing_reconciliation_state','ScanAuthorityEpoch','ScanWorkerInstanceGrant',
      'ScanDispatchOperation','ScanQueueOutbox','ScanDispatchAttempt','ScanDispatchOutbox',
      'ScanDispatchStart','ScanSupervisorReceipt','ScanPhysicalExecution',
      'ScanPhysicalExecutionTransition','ScanDispatchReleaseReceipt'
    )
  LOOP EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO dispatch_authority_runtime',item.tablename); END LOOP;
END \$\$;
CREATE ROLE dispatch_queue_publisher LOGIN PASSWORD '$queue_runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public, app TO dispatch_queue_publisher;
GRANT SELECT ON "Scan","Workspace","Target","Policy","users","ScanEvent","UserScanSlot","ScanCapacityReservation","ScanDispatchOperation","ScanQueueOutbox" TO dispatch_queue_publisher;
-- PostgreSQL row locks require UPDATE privilege on at least one column.
-- No status, authority identity, sponsor, budget or ledger writes are granted.
GRANT UPDATE ("updatedAt") ON "Scan","ScanDispatchOperation" TO dispatch_queue_publisher;
GRANT UPDATE (state,attempts,"leaseOwner","leaseExpiresAt","publishedAt","lastErrorCode","publicationReceiptInputJson","publicationReceiptChecksum","updatedAt") ON "ScanQueueOutbox" TO dispatch_queue_publisher;
CREATE POLICY fixture_queue_operation_select ON "ScanDispatchOperation" FOR SELECT TO dispatch_queue_publisher
  USING ("workspaceId"=current_setting('app.current_workspace_id',true));
CREATE POLICY fixture_queue_operation_lock ON "ScanDispatchOperation" FOR UPDATE TO dispatch_queue_publisher
  USING ("workspaceId"=current_setting('app.current_workspace_id',true));
CREATE POLICY fixture_queue_outbox_select ON "ScanQueueOutbox" FOR SELECT TO dispatch_queue_publisher
  USING (EXISTS (SELECT 1 FROM "ScanDispatchOperation" o WHERE o."operationId"="ScanQueueOutbox"."operationId" AND o."workspaceId"=current_setting('app.current_workspace_id',true)));
CREATE POLICY fixture_queue_outbox_update ON "ScanQueueOutbox" FOR UPDATE TO dispatch_queue_publisher
  USING (EXISTS (SELECT 1 FROM "ScanDispatchOperation" o WHERE o."operationId"="ScanQueueOutbox"."operationId" AND o."workspaceId"=current_setting('app.current_workspace_id',true)));
SQL

prior_reload=$(docker exec --user postgres "$container" psql -X -q -At -U postgres -d lyrashield_test -c 'SELECT pg_conf_load_time()')
docker exec --user postgres "$container" sh -c 'printf "local all postgres peer\nlocal all all reject\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n" > "$PGDATA/pg_hba.conf"; pg_ctl reload -D "$PGDATA" >/dev/null'
for _ in {1..100}; do
  current_reload=$(docker exec --user postgres "$container" psql -X -q -At -U postgres -d lyrashield_test -c 'SELECT pg_conf_load_time()')
  [[ "$current_reload" != "$prior_reload" ]] && break
  sleep 0.05
done
[[ "$current_reload" != "$prior_reload" ]] || { echo 'fixture authentication reload unavailable' >&2; exit 1; }

kill "$relay_pid" 2>/dev/null || true
wait "$relay_pid" 2>/dev/null || true
relay_pid=''
python3 "$repo_root/packages/db/scripts/tests/dispatch-authority-relay.py" \
  "$container" "$dir/fault-port" "$dir/armed" "$dir/commit-dropped" \
  >"$dir/relay.out" 2>"$dir/relay.err" &
relay_pid=$!
for _ in {1..100}; do
  [[ -s "$dir/fault-port" ]] && break
  kill -0 "$relay_pid" 2>/dev/null || { cat "$dir/relay.err" >&2; exit 1; }
  sleep 0.05
done
port=$(cat "$dir/fault-port")
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'Fixture fault relay unavailable' >&2; exit 1; }

# Suites share the one-shot fault relay; serialize files while tests explicitly
# exercise concurrent admissions, publishers and broker calls within each file.
BETTER_AUTH_SECRET=fixture-only-secret-32-characters-minimum BETTER_AUTH_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000 DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" RLS_RUNTIME_DATABASE_URL="postgresql://dispatch_authority_runtime:${runtime_password}@127.0.0.1:${port}/lyrashield_test" DISPATCH_AUTHORITY_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" DISPATCH_AUTHORITY_RUNTIME_DATABASE_URL="postgresql://dispatch_authority_runtime:${runtime_password}@127.0.0.1:${port}/lyrashield_test" QUEUE_OUTBOX_DATABASE_URL="postgresql://dispatch_queue_publisher:${queue_runtime_password}@127.0.0.1:${port}/lyrashield_test" REDIS_URL="redis://outbox-publisher:${redis_publisher_password}@127.0.0.1:${redis_port}/0" FAULT_ARM_PATH="$dir/armed" FAULT_MARKER_PATH="$dir/commit-dropped" LYRASHIELD_TEST_DB_DISPOSABLE=1 SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST=1   pnpm exec vitest run --no-file-parallelism "${test_files[@]}"
