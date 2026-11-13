#!/usr/bin/env bash
# Owns a disposable network-none PostgreSQL fixture; never accepts a DB URL.
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
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
dir=$(mktemp -d "${TMPDIR:-/tmp}/lyra-authority-mirror.XXXXXXXX")
printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=lyrashield_test\n' "$admin_password" > "$dir/postgres.env"
cleanup() {
  local status=$? observed
  trap - EXIT
  if [[ -n "$relay_pid" ]]; then kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true; fi
  if [[ -n "$container" ]]; then
    observed=$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.authority-mirror-fixture"}}|{{.HostConfig.NetworkMode}}' "$container" 2>/dev/null) || observed=''
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
container=$(docker create --pull=never --network none --label "lyrashield.authority-mirror-fixture=$identity" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m --env-file "$dir/postgres.env" "$image")
[[ "$(docker inspect --format '{{.Id}}|{{.Config.Image}}|{{index .Config.Labels "lyrashield.authority-mirror-fixture"}}|{{.HostConfig.NetworkMode}}' "$container")" == "$container|$image|$identity|none" ]] || exit 1
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
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test <<'SQL'
CREATE ROLE authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CREATE ON DATABASE lyrashield_test TO authority_owner;
SQL
{
  printf 'SET ROLE authority_owner;\n'
  cat packages/runtime-control/sql/authority-mirror.sql
  cat packages/runtime-control/sql/authority-seal.sql
  cat packages/runtime-control/sql/authority-seal-v2.sql
  printf 'RESET ROLE; REVOKE CREATE ON DATABASE lyrashield_test FROM authority_owner;\n'
} > "$dir/install.sql"
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test < "$dir/install.sql"
runtime_password=$(openssl rand -hex 24)
docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d lyrashield_test <<SQL
CREATE ROLE authority_mirror LOGIN PASSWORD '$runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE authority_worker LOGIN PASSWORD '$runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA lyrashield_authority TO authority_mirror;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA lyrashield_authority TO authority_mirror;
SQL
DATABASE_URL="postgresql://postgres:${admin_password}@127.0.0.1:${port}/lyrashield_test" \
RLS_RUNTIME_DATABASE_URL="postgresql://authority_mirror:${runtime_password}@127.0.0.1:${port}/lyrashield_test" \
LYRASHIELD_TEST_DB_DISPOSABLE=1 AUTHORITY_MIRROR_POSTGRES_TEST=1 \
  pnpm exec vitest run packages/runtime-control/src/postgres-mirror.runtime.test.ts "$@"
