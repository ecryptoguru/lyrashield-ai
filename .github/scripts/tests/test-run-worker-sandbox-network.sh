#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="$repo/ops/worker/run-worker.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/cold-start"
sed "s|/var/lib/lyrashield/worker-cold-start|$tmp/cold-start|g" "$script" > "$tmp/run-worker.sh"
script="$tmp/run-worker.sh"
cat > "$tmp/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$1 ${2:-}" in
  'network inspect')
    [ "$#" = 5 ] && [ "$3" = --format ] && [ "$5" = "$MOCK_NETWORK_NAME" ] || exit 90
    [ "$4" = '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.enable_icc"}}' ] || exit 90
    [ "$MOCK_NETWORK_STATE" != missing ] || exit 1
    printf '%s\n' "$MOCK_NETWORK_STATE"
    ;;
  'login ghcr.io')
    # End successful admission at the first registry operation. No real pulls,
    # host directory creation, container removal or consumer startup can occur.
    exit 88
    ;;
  *) echo "Unexpected Docker operation: $*" >&2; exit 90 ;;
esac
MOCK
cat > "$tmp/bin/flock" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cat > "$tmp/bin/sync" <<'MOCK'
#!/bin/sh
set -eu
[ "$1" = -f ] && [ -f "$2/owner-started" ] || exit 90
[ -z "${MOCK_SYNC_FAIL:-}" ] || exit 1
printf '%s\n' synced > "$2/sync-receipt"
MOCK
chmod +x "$tmp/bin/docker" "$tmp/bin/flock" "$tmp/bin/sync"

digest=$(printf 'a%.0s' {1..64})
cat > "$tmp/runtime.conf" <<EOF
LYRASHIELD_WORKER_IMAGE=ghcr.io/example/worker@sha256:$digest
LYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:$digest
GHCR_USERNAME=fixture
EOF
printf 'GHCR_TOKEN=fixture\n' > "$tmp/worker.env"
: > "$tmp/worker-env.sh"

run_case() {
  local name=$1 state=$2 allowed=$3 network=${4:-lyrashield-sandbox}
  local log="$tmp/$name.docker.log" output="$tmp/$name.output" status=0
  : > "$log"
  rm -f "$tmp/cold-start/owner-started" "$tmp/cold-start/sync-receipt"
  PATH="$tmp/bin:$PATH" \
    LYRASHIELD_WORKER_COLD_START_DIR="$tmp/cold-start" \
    LYRASHIELD_WORKER_RUNTIME_CONFIG="$tmp/runtime.conf" \
    LYRASHIELD_WORKER_ENV_FILE="$tmp/worker.env" \
    LYRASHIELD_WORKER_ENV_LIB="$tmp/worker-env.sh" \
    LYRASHIELD_SANDBOX_NETWORK="$network" \
    MOCK_NETWORK_NAME="$network" MOCK_NETWORK_STATE="$state" MOCK_DOCKER_LOG="$log" \
    sh "$script" > "$output" 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "$name: expected controlled startup rejection, got status $status" >&2
    cat "$output" >&2
    exit 1
  fi
  if [ "$allowed" = yes ]; then
    if ! grep -Fq 'Unable to authenticate ghcr.io' "$output" ||
      [ "$(wc -l < "$log" | tr -d ' ')" -ne 2 ] ||
      ! sed -n '1p' "$log" | grep -Fq "network inspect --format" ||
      ! sed -n '2p' "$log" | grep -Fq 'login ghcr.io'; then
      echo "$name: valid network did not pass admission before registry authentication" >&2
      cat "$output" "$log" >&2
      exit 1
    fi
  else
    if ! grep -Fq 'Sandbox network' "$output" ||
      ! grep -Fq 'com.docker.network.bridge.enable_icc=false' "$output" ||
      [ "$(wc -l < "$log" | tr -d ' ')" -ne 1 ] ||
      ! grep -Fq "network inspect --format" "$log"; then
      echo "$name: invalid network reached registry/setup or lacked an actionable admission error" >&2
      cat "$output" "$log" >&2
      exit 1
    fi
  fi
  [ -f "$tmp/cold-start/sync-receipt" ] || { echo "FAIL: missing durable startup sync" >&2; exit 1; }
  echo "PASS: $name"
}

# Removing admission validation or accepting a default/missing ICC option must
# fail these cases before the first authenticated or mutating Docker operation.
run_case missing-network missing no
run_case external-network 'bridge|false|false' no
run_case wrong-driver 'overlay|true|false' no
run_case icc-enabled 'bridge|true|true' no
run_case icc-default 'bridge|true|<no value>' no
run_case icc-empty 'bridge|true|' no
run_case malformed-inspection '{invalid-json' no
run_case malformed-boolean 'bridge|TRUE|false' no
run_case multiple-networks $'bridge|true|false\nbridge|true|false' no
run_case valid-network 'bridge|true|false' yes
run_case configured-network 'bridge|true|false' yes private-sandbox

# A crash may leave a late accepted Docker create. An empty inventory cannot
# authorize another owner: both barrier and prior-start fences reject before
# any native or registry operation.
rm -f "$tmp/cold-start/owner-started"
for fence in pending owner-started; do
  : > "$tmp/cold-start/$fence"
  log="$tmp/$fence.docker.log"
  : > "$log"
  status=0
  PATH="$tmp/bin:$PATH" \
    LYRASHIELD_WORKER_COLD_START_DIR="$tmp/cold-start" \
    MOCK_DOCKER_LOG="$log" \
    LYRASHIELD_WORKER_RUNTIME_CONFIG="$tmp/runtime.conf" \
    LYRASHIELD_WORKER_ENV_FILE="$tmp/worker.env" \
    LYRASHIELD_WORKER_ENV_LIB="$tmp/worker-env.sh" \
    sh "$script" >"$tmp/$fence.output" 2>&1 || status=$?
  [ "$status" -eq 1 ] && [ ! -s "$log" ] &&
    grep -Fq 'Unresolved cold host barrier' "$tmp/$fence.output" || {
      echo "FAIL: $fence did not prevent native restart" >&2
      exit 1
    }
  rm "$tmp/cold-start/$fence"
  echo "PASS: $fence blocks native restart"
done

: > "$tmp/sync-failure.docker.log"
status=0
PATH="$tmp/bin:$PATH" MOCK_SYNC_FAIL=1 MOCK_DOCKER_LOG="$tmp/sync-failure.docker.log" \
  LYRASHIELD_WORKER_COLD_START_DIR="$tmp/cold-start" \
  LYRASHIELD_WORKER_RUNTIME_CONFIG="$tmp/runtime.conf" \
  LYRASHIELD_WORKER_ENV_FILE="$tmp/worker.env" \
  LYRASHIELD_WORKER_ENV_LIB="$tmp/worker-env.sh" \
  sh "$script" >"$tmp/sync-failure.output" 2>&1 || status=$?
[ "$status" -eq 1 ] && [ ! -s "$tmp/sync-failure.docker.log" ] &&
  [ -f "$tmp/cold-start/owner-started" ] &&
  grep -Fq 'Cold owner fence could not be persisted' "$tmp/sync-failure.output" || {
    echo "FAIL: failed sync allowed native startup or erased fence" >&2
    exit 1
  }
echo "PASS: failed sync blocks native startup and preserves fence"
