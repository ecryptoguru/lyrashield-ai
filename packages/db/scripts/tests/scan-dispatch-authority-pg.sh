#!/usr/bin/env bash
# Owns a disposable network-none PostgreSQL fixture; never accepts a DB URL.
set -euo pipefail
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
identity=$(openssl rand -hex 24)
admin_password=$(openssl rand -hex 24)
container=''
relay_pid=''
umask 077
dir=$(mktemp -d "${TMPDIR:-/tmp}/lyra-dispatch-authority.XXXXXXXX")
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=lyrashield_test\n' "$admin_password" > "$dir/postgres.env"
cleanup() {
  local status=$? observed
  trap - EXIT
  if [[ -n "$relay_pid" ]]; then kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true; fi
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
docker exec -i "$container" psql -X -U postgres -d lyrashield_test -v ON_ERROR_STOP=1 <<SQL
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

BETTER_AUTH_SECRET=fixture-only-secret-32-characters-minimum BETTER_AUTH_URL=http://localhost:3000 NEXT_PUBLIC_APP_URL=http://localhost:3000 DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" RLS_RUNTIME_DATABASE_URL="postgresql://dispatch_authority_runtime:${runtime_password}@127.0.0.1:${port}/lyrashield_test" DISPATCH_AUTHORITY_DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" DISPATCH_AUTHORITY_RUNTIME_DATABASE_URL="postgresql://dispatch_authority_runtime:${runtime_password}@127.0.0.1:${port}/lyrashield_test" FAULT_ARM_PATH="$dir/armed" FAULT_MARKER_PATH="$dir/commit-dropped" LYRASHIELD_TEST_DB_DISPOSABLE=1 SCAN_DISPATCH_AUTHORITY_POSTGRES_TEST=1   pnpm exec vitest run packages/db/src/scan-dispatch-authority-broker.postgres.test.ts packages/db/src/scan-dispatch-admission.postgres.test.ts
