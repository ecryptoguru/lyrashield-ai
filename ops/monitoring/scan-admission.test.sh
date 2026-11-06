#!/bin/sh
set -eu

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
state_file="$test_dir/state"
printf '%s' '{"value":null,"ttl":-1}' > "$state_file"
ln -s "$PWD/.github/scripts/tests/fixtures/redis-cli-owned-hold.mjs" "$test_dir/redis-cli"
export PATH="$test_dir:$PATH"
export FAKE_REDIS_STATE="$state_file"
export REDIS_URL="rediss://monitoring.test:6379"

sh ops/monitoring/scan-admission.sh stop on-call queue_uncertain >/dev/null
if sh ops/monitoring/scan-admission.sh status >/dev/null; then
  echo "status must be non-zero while admission is stopped" >&2
  exit 1
fi
if sh ops/monitoring/scan-admission.sh resume another-operator >/dev/null 2>&1; then
  echo "manual resume must preserve another operator's stop" >&2
  exit 1
fi
sh ops/monitoring/scan-admission.sh resume on-call >/dev/null
test "$(sh ops/monitoring/scan-admission.sh status)" = "Scan admission active"
