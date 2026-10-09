#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat > "$tmp/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf 'docker %s\n' "$*" >> "$MOCK_ORDER_LOG"
case "$1 ${2:-}" in
  'network inspect')
    case "$4" in
      '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.enable_icc"}}') printf 'bridge|true|false\n' ;;
      *) exit 90 ;;
    esac ;;
  'image inspect'|'login ghcr.io'|'rm -f'|'run --rm'|'create --name') : ;;
  'start --attach') printf 'consumer-started\n' ;;
  *) echo "Unexpected Docker operation: $*" >&2; exit 90 ;;
esac
MOCK
cat > "$tmp/bin/install" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cat > "$tmp/bin/stat" <<'MOCK'
#!/bin/sh
[ "$*" = '-c %g /var/run/docker.sock' ] || exit 90
printf '0\n'
MOCK
cat > "$tmp/refresh-egress" <<'MOCK'
#!/bin/sh
set -eu
[ "$LYRASHIELD_REQUIRE_SANDBOX_CONTROL" = 1 ] || exit 90
printf 'sandbox-control-policy\n' >> "$MOCK_ORDER_LOG"
[ "$MOCK_POLICY_FAIL" = 0 ] || exit 1
MOCK
chmod +x "$tmp/bin/"* "$tmp/refresh-egress"

digest=$(printf 'a%.0s' {1..64})
cat > "$tmp/runtime.conf" <<EOF
LYRASHIELD_WORKER_IMAGE=ghcr.io/example/worker@sha256:$digest
LYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:$digest
GHCR_USERNAME=fixture
EOF
printf 'GHCR_TOKEN=fixture\n' > "$tmp/worker.env"
printf 'service.example 1.1.1.1 443\n' > "$tmp/pins"
cat > "$tmp/worker-env.sh" <<'MOCK'
lyrashield_worker_env_args() { printf '%s\n' '--env NODE_ENV=production'; }
MOCK

run_case() {
  local name=$1 allowed=$2 policy_fail=${3:-0} helper=${4:-$tmp/refresh-egress}
  local log="$tmp/$name.log" output="$tmp/$name.output" status=0
  : > "$log"
  PATH="$tmp/bin:$PATH" \
    LYRASHIELD_WORKER_RUNTIME_CONFIG="$tmp/runtime.conf" \
    LYRASHIELD_WORKER_ENV_FILE="$tmp/worker.env" \
    LYRASHIELD_WORKER_ENV_LIB="$tmp/worker-env.sh" \
    LYRASHIELD_WORKER_EGRESS_SCRIPT="$helper" \
    LYRASHIELD_EGRESS_PIN_FILE="$tmp/pins" \
    MOCK_ORDER_LOG="$log" MOCK_POLICY_FAIL="$policy_fail" \
    sh "$repo/ops/worker/run-worker.sh" > "$output" 2>&1 || status=$?
  if [ "$allowed" = yes ]; then
    if [ "$status" -ne 0 ] || ! grep -Fxq consumer-started "$output"; then
      echo "$name: worker did not start after validated control policy" >&2
      cat "$output" "$log" >&2
      exit 1
    fi
    # Removing policy installation or starting the consumer before the policy
    # is installed must fail this real launcher test.
    local last_two
    last_two=$(tail -n 2 "$log")
    if [ "$last_two" != "sandbox-control-policy
docker start --attach lyrashield-worker" ]; then
      echo "$name: worker started before its cross-bridge control policy" >&2
      cat "$log" >&2
      exit 1
    fi
  elif [ "$status" -eq 0 ] || grep -Fq 'docker start' "$log"; then
    echo "$name: unavailable or failed control policy reached the consumer" >&2
    cat "$output" "$log" >&2
    exit 1
  fi
  if [ "$policy_fail" = 1 ] && ! grep -Fxq sandbox-control-policy "$log"; then
    echo "$name: control-policy failure fixture was not exercised" >&2
    cat "$output" "$log" >&2
    exit 1
  fi
  if grep -Fq 'docker network connect' "$log" ||
    ! grep -Fq 'docker create --name lyrashield-worker --network bridge ' "$log"; then
    echo "$name: worker did not remain exclusively on the outbound bridge" >&2
    cat "$output" "$log" >&2
    exit 1
  fi
  if [ "$helper" != "$tmp/refresh-egress" ] &&
    ! grep -Fq 'Worker egress policy helper is unavailable:' "$output"; then
    echo "$name: missing helper failed for an unrelated reason" >&2
    cat "$output" "$log" >&2
    exit 1
  fi
  echo "PASS: $name"
}

run_case valid-control yes
run_case policy-install-failed no 1
run_case missing-helper no 0 "$tmp/missing-helper"
