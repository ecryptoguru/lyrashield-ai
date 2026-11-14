#!/usr/bin/env bash
# Owns a disposable network-none PostgreSQL fixture; never accepts a DB URL.
set -euo pipefail
if [[ "$#" -gt 1 ]]; then echo 'Usage: scan-dispatch-authority-pg.sh [--admission-only|--outbox-only|--preparation-only|--receipts-only|--journal-only|--actions-only|--native-origin-only|--source-only|--context-only]' >&2; exit 1; fi
case "${1:-}" in
  '') test_files=(packages/db/src/scan-dispatch-authority-broker.postgres.test.ts packages/db/src/scan-dispatch-admission.postgres.test.ts packages/db/src/scan-queue-outbox.postgres.test.ts packages/db/src/scan-preparation-authority.postgres.test.ts packages/db/src/scan-policy-authority.postgres.test.ts packages/db/src/scan-dispatch-command-descriptor.postgres.test.ts) ;;
  --admission-only) test_files=(packages/db/src/scan-dispatch-admission.postgres.test.ts) ;;
  --actions-only) test_files=(packages/db/src/scan-execution-action-authority.postgres.test.ts) ;;
  --native-origin-only) test_files=(packages/db/src/scan-native-origin-authority-reader.postgres.test.ts) ;;
  --source-only) test_files=(packages/db/src/scan-preparation-source-reader.postgres.test.ts) ;;
  --receipts-only) test_files=(packages/db/src/scan-supervisor-receipt-ingestion.postgres.test.ts) ;;
  --journal-only) test_files=(packages/runtime-control/src/installed-supervisor-journal.postgres.test.ts) ;;
  --preparation-only) test_files=(packages/db/src/scan-preparation-authority.postgres.test.ts packages/db/src/scan-policy-authority.postgres.test.ts packages/db/src/scan-dispatch-command-descriptor.postgres.test.ts) ;;
  --outbox-only) test_files=(packages/db/src/scan-queue-outbox.postgres.test.ts) ;;
  --context-only) test_files=(packages/db/src/disposable-execution-context.postgres.test.ts) ;;
  *) echo 'Usage: scan-dispatch-authority-pg.sh [--admission-only|--outbox-only|--preparation-only|--receipts-only|--journal-only|--actions-only|--native-origin-only|--source-only|--context-only]' >&2; exit 1 ;;
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
provider_container=''
provider_relay_pid=''
provider_image=''
provider_tag=''
umask 077
dir=$(mktemp -d "${TMPDIR:-/tmp}/lyra-dispatch-authority.XXXXXXXX")
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=lyrashield_test\n' "$admin_password" > "$dir/postgres.env"
cleanup() {
  local status=$? observed
  trap - EXIT
  if [[ -n "$relay_pid" ]]; then kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true; fi
  if [[ -n "$redis_relay_pid" ]]; then kill "$redis_relay_pid" 2>/dev/null || true; wait "$redis_relay_pid" 2>/dev/null || true; fi
  if [[ -n "$provider_relay_pid" ]]; then kill "$provider_relay_pid" 2>/dev/null || true; wait "$provider_relay_pid" 2>/dev/null || true; fi
  if [[ -n "$provider_container" ]]; then
    observed=$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.dispatch-authority-fixture"}}|{{.HostConfig.NetworkMode}}' "$provider_container" 2>/dev/null) || observed=''
    if [[ "$observed" == "$provider_container|$provider_image|$identity|none" ]]; then
      docker rm -f -v "$provider_container" >/dev/null || status=1
    else echo 'Refusing to remove unverified synthetic provider fixture' >&2; status=1; fi
  fi
  if [[ -n "$provider_image" ]]; then
    observed=$(docker image inspect "$provider_tag" --format '{{.Id}}' 2>/dev/null) || observed=''
    if [[ "$observed" == "$provider_image" ]]; then docker image rm "$provider_tag" >/dev/null || status=1
    else echo 'Refusing to remove unverified synthetic provider image' >&2; status=1; fi
  fi
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
# Legacy authority rows must be created before the additive checked-intent
# migration. Test-owned staging copies preserve exact original migration bytes.
mkdir "$dir/migrations"
for migration in "$repo_root"/packages/db/prisma/migrations/*; do
  case "$(basename "$migration")" in
    20261111130000_scan_preparation_authority_fence|20261113140000_scan_dispatch_command_descriptor|20261113150000_supervisor_receipt_ingestion|20261113163000_scan_execution_action_authority|20261113170000_supervisor_execution_receipts|20261113181000_supervisor_native_invocation_resolution|20261113200000_supervisor_preparation_completion|20261114010000_scope_invocation_guard_to_workspace|20261114020000_supervisor_journal_stream_binding|20261114120000_scan_dispatch_worker_assignment|20261114133000_scan_dispatch_lifecycle_commands|20261114150000_scan_native_guard_backend|20261114150000_scan_sandbox_tool_authority|20261114160000_scan_native_origin_authority_reader|20261114170000_scan_dispatch_lifecycle_proof_acceptance|20261114170000_scan_preparation_source_reader|20261114183000_scan_native_retirement_proof|20261114184000_scan_native_retained_authority_reader|20261114184500_scan_installed_worker_grant_reader|20261114185000_scan_dispatch_cleanup_invocation_fence|20261114185500_scan_native_tool_retirement_reader|20261114200000_scan_worker_result_observation_reader|20261114210000_scan_worker_retained_cleanup_reader) continue ;;
  esac
  if [[ -d "$migration" ]]; then
    mkdir "$dir/migrations/$(basename "$migration")"
    cp "$migration/migration.sql" "$dir/migrations/$(basename "$migration")/migration.sql"
  else
    cp "$migration" "$dir/migrations/$(basename "$migration")"
  fi
done
cat > "$dir/fixture.prisma.config.ts" <<CONFIG
export default { schema: '$repo_root/packages/db/prisma/schema.prisma', migrations: { path: '$dir/migrations' }, datasource: { url: process.env.DATABASE_URL } }
CONFIG
DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" \
  pnpm --filter @lyrashield/db exec prisma migrate deploy --config "$dir/fixture.prisma.config.ts"
docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test \
  -c 'CREATE DATABASE lyrashield_authority_shadow' >/dev/null
runtime_password=$(openssl rand -hex 24)
queue_runtime_password=$(openssl rand -hex 24)
preparation_password=$(openssl rand -hex 24)
revoker_password=$(openssl rand -hex 24)
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
      'ScanDispatchStart','ScanSupervisorReceipt','ScanSupervisorJournalStream','ScanSupervisorJournalRecord','ScanExecutionActionIntent','ScanExecutionInvocationGuard','ScanExecutionInvocationResolution','ScanPhysicalExecution',
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
  "$container" "$dir/fault-port" "$dir/armed" "$dir/commit-dropped" "$dir/delay-armed" "$dir/commit-delayed" "$dir/live-delay-armed" "$dir/live-delayed" "$dir/live-stall-armed" "$dir/live-stalled" \
  >"$dir/relay.out" 2>"$dir/relay.err" &
relay_pid=$!
for _ in {1..100}; do
  [[ -s "$dir/fault-port" ]] && break
  kill -0 "$relay_pid" 2>/dev/null || { cat "$dir/relay.err" >&2; exit 1; }
  sleep 0.05
done
port=$(cat "$dir/fault-port")
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'Fixture fault relay unavailable' >&2; exit 1; }

if [[ "${1:-}" == '--context-only' ]]; then
  provider_tag="lyrashield-disposable-provider-${identity:0:16}"
  mkdir "$dir/provider-source"
  cp "$repo_root/ops/prototypes/dispatch-plan-test/synthetic_provider.sh" "$dir/provider-source/synthetic_provider.sh"
  chmod 755 "$dir/provider-source/synthetic_provider.sh"
  cat > "$dir/provider-source/Dockerfile" <<'EOF'
FROM postgres:17-alpine
COPY synthetic_provider.sh /opt/fixture/provider.sh
USER postgres
ENTRYPOINT ["/bin/busybox","nc","-lk","-s","127.0.0.1","-p","5432","-e","/opt/fixture/provider.sh"]
CMD []
EOF
  DOCKER_BUILDKIT=0 docker build --network=none --pull=false -t "$provider_tag" "$dir/provider-source" >"$dir/provider-build.out" 2>"$dir/provider-build.err"
  [[ "$(docker image inspect postgres:17-alpine --format '{{.Id}}')" == "$image" ]] || exit 1
  provider_image=$(docker image inspect "$provider_tag" --format '{{.Id}}')
  [[ "$provider_image" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
  provider_container=$(docker create --pull=never --read-only --tmpfs /var/lib/postgresql/data:ro,noexec,nosuid,nodev --network none \
    --label "lyrashield.dispatch-authority-fixture=$identity" --label 'lyrashield.fixture-role=synthetic-provider' "$provider_image")
  docker start "$provider_container" >/dev/null
  python3 "$repo_root/ops/prototypes/dispatch-plan-test/relay.py" "$provider_container" "$dir/provider-port" >"$dir/provider-relay.out" 2>"$dir/provider-relay.err" &
  provider_relay_pid=$!
  for _ in {1..100}; do
    [[ -s "$dir/provider-port" ]] && break
    kill -0 "$provider_relay_pid" 2>/dev/null || { echo 'Provider fixture relay unavailable' >&2; exit 1; }
    sleep 0.05
  done
  [[ -s "$dir/provider-port" ]] || exit 1
  for _ in {1..100}; do
    if docker exec "$provider_container" nc -z 127.0.0.1 5432 >/dev/null 2>&1; then break; fi
    sleep 0.05
  done
  LYRA_DISPOSABLE_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" \
    python3 "$repo_root/ops/prototypes/dispatch-plan-test/observe_execution_context.py" \
      --database-container "$container" --provider-container "$provider_container" --owner "$identity" \
      --relay-pid "$relay_pid" --relay-port-file "$dir/fault-port" --database lyrashield_test \
      --provider-relay-pid "$provider_relay_pid" --provider-relay-port-file "$dir/provider-port" > "$dir/context.json"
  export LYRA_DISPOSABLE_CONTEXT_TEST=1 LYRA_CONTEXT_DATABASE_CONTAINER="$container" LYRA_CONTEXT_PROVIDER_CONTAINER="$provider_container"
  export LYRA_CONTEXT_OWNER="$identity" LYRA_CONTEXT_DATABASE_RELAY_PID="$relay_pid" LYRA_CONTEXT_DATABASE_RELAY_PORT_FILE="$dir/fault-port"
  export LYRA_CONTEXT_PROVIDER_RELAY_PID="$provider_relay_pid" LYRA_CONTEXT_PROVIDER_RELAY_PORT_FILE="$dir/provider-port"
  export LYRA_CONTEXT_RECORD="$dir/context.json" LYRA_DISPOSABLE_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test"
fi

# Suites share the one-shot fault relay; serialize files while tests explicitly
# exercise concurrent admissions, publishers and broker calls within each file.
TZ=UTC DISPATCH_AUTHORITY_REVOKER_PASSWORD="$revoker_password" DISPATCH_AUTHORITY_REVOKER_DATABASE_URL="postgresql://dispatch_authority_revoker:${revoker_password}@127.0.0.1:${port}/lyrashield_test" DISPATCH_PREPARATION_BROKER_PASSWORD="$preparation_password" DISPATCH_PREPARATION_BROKER_DATABASE_URL="postgresql://dispatch_prepare_broker:${preparation_password}@127.0.0.1:${port}/lyrashield_test" BETTER_AUTH_SECRET=fixture-only-secret-32-characters-minimum BETTER_AUTH_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000 DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" DATABASE_DIRECT_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" RLS_RUNTIME_DATABASE_URL="postgresql://dispatch_authority_runtime:${runtime_password}@127.0.0.1:${port}/lyrashield_test" DISPATCH_AUTHORITY_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" DISPATCH_AUTHORITY_RUNTIME_DATABASE_URL="postgresql://dispatch_authority_runtime:${runtime_password}@127.0.0.1:${port}/lyrashield_test" QUEUE_OUTBOX_DATABASE_URL="postgresql://dispatch_queue_publisher:${queue_runtime_password}@127.0.0.1:${port}/lyrashield_test" REDIS_URL="redis://outbox-publisher:${redis_publisher_password}@127.0.0.1:${redis_port}/0" FAULT_ARM_PATH="$dir/armed" FAULT_MARKER_PATH="$dir/commit-dropped" DELAY_ARM_PATH="$dir/delay-armed" DELAY_MARKER_PATH="$dir/commit-delayed" LIVE_DELAY_ARM_PATH="$dir/live-delay-armed" LIVE_DELAY_MARKER_PATH="$dir/live-delayed" LIVE_STALL_ARM_PATH="$dir/live-stall-armed" LIVE_STALL_MARKER_PATH="$dir/live-stalled" LYRASHIELD_TEST_DB_DISPOSABLE=1 SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST=1   pnpm exec vitest run --no-file-parallelism "${test_files[@]}"

if [[ "${1:-}" == '--context-only' ]]; then exit 0; fi

# Admission-only does not load preparation fixtures. Apply the additive SQL only
# after admission validation; never seed or relabel new rows as legacy.
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM information_schema.columns WHERE table_name='ScanDispatchAttempt' AND column_name='authorityAcceptedAt'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261111130000_scan_preparation_authority_fence/migration.sql" >/dev/null
fi
# Admission-only omits the checked-intent fixtures; restore dependent SQL in its
# real chronological order after legacy admission validation.
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM information_schema.columns WHERE table_name='ScanDispatchOutbox' AND column_name='commandInputJson'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261113140000_scan_dispatch_command_descriptor/migration.sql" >/dev/null
fi
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM information_schema.tables WHERE table_name='ScanSupervisorJournalStream'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261113150000_supervisor_receipt_ingestion/migration.sql" >/dev/null
fi
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM information_schema.tables WHERE table_name='ScanExecutionActionIntent'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261113163000_scan_execution_action_authority/migration.sql" >/dev/null
fi
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='ScanSupervisorReceiptType' AND e.enumlabel='EXECUTOR_CREATED'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261113170000_supervisor_execution_receipts/migration.sql" >/dev/null
fi
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_execution_invocation_resolution_guard' AND position('invocation resolution lacks exact confirmed original native ACK' in p.prosrc)>0 OR (n.nspname='app' AND p.proname='scan_supervisor_preparation_completed')")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261113181000_supervisor_native_invocation_resolution/migration.sql" >/dev/null
fi
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_supervisor_preparation_completed'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261113200000_supervisor_preparation_completion/migration.sql" >/dev/null
fi
# Prisma first sends an SSL negotiation frame; fault injection is complete.
# Restore the transparent owned relay for schema verification.
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_execution_invocation_pending' AND position('workspace_id' in p.prosrc)>0")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -1 -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261114010000_scope_invocation_guard_to_workspace/migration.sql" >/dev/null
fi
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_supervisor_journal_stream_matches'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261114020000_supervisor_journal_stream_binding/migration.sql" >/dev/null
fi
if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "SELECT count(*) FROM information_schema.tables WHERE table_name='ScanDispatchWorkerAssignment'")" == '0' ]]; then
  docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/20261114120000_scan_dispatch_worker_assignment/migration.sql" >/dev/null
fi
# These depend on the action/receipt tables created by the legacy fixture stage.
for migration_check in \
  "20261114133000_scan_dispatch_lifecycle_commands|SELECT count(*) FROM information_schema.columns WHERE table_name='ScanDispatchOutbox' AND column_name='executorKey'" \
  "20261114150000_scan_native_guard_backend|SELECT count(*) FROM information_schema.columns WHERE table_name='ScanExecutionInvocationGuard' AND column_name='nativeBackendPid'" \
  "20261114150000_scan_sandbox_tool_authority|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_execution_action_intent_guard' AND position('sandbox tool original ownership unavailable' in p.prosrc)>0" \
  "20261114160000_scan_native_origin_authority_reader|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_native_executor_origin_gate_held'" \
  "20261114170000_scan_dispatch_lifecycle_proof_acceptance|SELECT count(*) FROM information_schema.tables WHERE table_name='ScanDispatchLifecycleProof'" \
  "20261114170000_scan_preparation_source_reader|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='require_scan_preparation_source_role'" \
  "20261114183000_scan_native_retirement_proof|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_native_retirement_guard'" \
  "20261114184000_scan_native_retained_authority_reader|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_native_retained_guard'" \
  "20261114184500_scan_installed_worker_grant_reader|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_installed_worker_grant'" \
  "20261114185000_scan_dispatch_cleanup_invocation_fence|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='scan_dispatch_cleanup_invocation_fence'" \
  "20261114185500_scan_native_tool_retirement_reader|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_native_pending_tool_guards'" \
  "20261114200000_scan_worker_result_observation_reader|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_installed_worker_operations'" \
  "20261114210000_scan_worker_retained_cleanup_reader|SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='read_scan_installed_worker_cleanup_operations'"; do
  late_migration=${migration_check%%|*}
  existence_query=${migration_check#*|}
  if [[ "$(docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -q -At -U postgres -d lyrashield_test -c "$existence_query")" == '0' ]]; then
    docker exec -i -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -1 -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$repo_root/packages/db/prisma/migrations/$late_migration/migration.sql" >/dev/null
  fi
done
kill "$relay_pid" 2>/dev/null || true
wait "$relay_pid" 2>/dev/null || true
python3 "$repo_root/ops/prototypes/dispatch-plan-test/relay.py" "$container" "$dir/schema-port" "$dir/stop-relay" >"$dir/schema-relay.out" 2>"$dir/schema-relay.err" &
relay_pid=$!
for _ in {1..100}; do
  [[ -s "$dir/schema-port" ]] && break
  kill -0 "$relay_pid" 2>/dev/null || { echo 'Fixture schema relay unavailable' >&2; exit 1; }
  sleep 0.05
done
port=$(cat "$dir/schema-port")
[[ "$port" =~ ^[0-9]+$ ]] || { echo 'Fixture schema port unavailable' >&2; exit 1; }
fixture_url="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test"
for applied_migration in 20261111130000_scan_preparation_authority_fence 20261113140000_scan_dispatch_command_descriptor 20261113150000_supervisor_receipt_ingestion 20261113163000_scan_execution_action_authority 20261113170000_supervisor_execution_receipts 20261113181000_supervisor_native_invocation_resolution 20261113200000_supervisor_preparation_completion 20261114010000_scope_invocation_guard_to_workspace 20261114020000_supervisor_journal_stream_binding 20261114120000_scan_dispatch_worker_assignment 20261114133000_scan_dispatch_lifecycle_commands 20261114150000_scan_native_guard_backend 20261114150000_scan_sandbox_tool_authority 20261114160000_scan_native_origin_authority_reader 20261114170000_scan_dispatch_lifecycle_proof_acceptance 20261114170000_scan_preparation_source_reader 20261114183000_scan_native_retirement_proof 20261114184000_scan_native_retained_authority_reader 20261114184500_scan_installed_worker_grant_reader 20261114185000_scan_dispatch_cleanup_invocation_fence 20261114185500_scan_native_tool_retirement_reader 20261114200000_scan_worker_result_observation_reader 20261114210000_scan_worker_retained_cleanup_reader; do
  DATABASE_URL="$fixture_url" DATABASE_DIRECT_URL="$fixture_url" pnpm --filter @lyrashield/db exec prisma migrate resolve --applied "$applied_migration"
done
# The repository prisma.config.ts prefers DATABASE_DIRECT_URL, which a developer
# .env may point at a different server. Pin both to the fixture so final Prisma
# validation checks the database the suite actually migrated.
DATABASE_URL="$fixture_url" DATABASE_DIRECT_URL="$fixture_url" SHADOW_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_authority_shadow" pnpm --filter @lyrashield/db exec prisma migrate diff --exit-code --from-migrations prisma/migrations --to-schema prisma/schema.prisma
DATABASE_URL="$fixture_url" DATABASE_DIRECT_URL="$fixture_url" pnpm --filter @lyrashield/db exec prisma migrate diff --exit-code --from-config-datasource --to-schema prisma/schema.prisma

# Epoch closure uses an independent clone after all source fixture clients end;
# it cannot close the shared epoch used by another suite or depend on file order.
# Native-origin tests intentionally retain unresolved guards; epoch fixtures own
# a separate qualification and must not rewrite those recovery obligations.
if [[ "${1:-}" != '--admission-only' && "${1:-}" != '--native-origin-only' ]]; then
  docker exec -e "PGPASSWORD=$admin_password" "$container" psql -h 127.0.0.1 -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test -c 'CREATE DATABASE lyrashield_epoch_test TEMPLATE lyrashield_test' >/dev/null
  TZ=UTC BETTER_AUTH_SECRET=fixture-only-secret-32-characters-minimum BETTER_AUTH_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000 DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_epoch_test" DATABASE_DIRECT_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_epoch_test" DISPATCH_PREPARATION_BROKER_PASSWORD="$preparation_password" DISPATCH_PREPARATION_BROKER_DATABASE_URL="postgresql://dispatch_prepare_broker:${preparation_password}@127.0.0.1:${port}/lyrashield_epoch_test" DISPATCH_AUTHORITY_REVOKER_PASSWORD="$revoker_password" DISPATCH_AUTHORITY_REVOKER_DATABASE_URL="postgresql://dispatch_authority_revoker:${revoker_password}@127.0.0.1:${port}/lyrashield_epoch_test" REDIS_URL="redis://outbox-publisher:${redis_publisher_password}@127.0.0.1:${redis_port}/0" LYRASHIELD_TEST_DB_DISPOSABLE=1 SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST=1 pnpm exec vitest run packages/db/src/scan-preparation-epoch.postgres.test.ts
fi
