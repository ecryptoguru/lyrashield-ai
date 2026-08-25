#!/bin/sh
set -eu

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT

cat >"$test_dir/az" <<'EOF'
#!/bin/sh
set -eu
attempt_file=${FAKE_AZ_ATTEMPT_FILE:?}
attempt=$(cat "$attempt_file")
attempt=$((attempt + 1))
printf '%s' "$attempt" >"$attempt_file"
if [ "$attempt" -lt "${FAKE_AZ_SUCCEED_ON:-1}" ]; then
  printf '%s\n' "${FAKE_AZ_ERROR:-(Conflict) Run command extension execution is in progress}" >&2
  exit 1
fi
printf 'EGRESS_HEALTH_OK\n'
EOF
chmod +x "$test_dir/az"

cat >"$test_dir/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$test_dir/sleep"

export PATH="$test_dir:$PATH"
export FAKE_AZ_ATTEMPT_FILE="$test_dir/attempts"

. ops/deployment/azure-vm-run-command.sh

printf '0' >"$FAKE_AZ_ATTEMPT_FILE"
export FAKE_AZ_SUCCEED_ON=3
result=$(azure_vm_run_command_with_retry --name worker)
[ "$result" = "EGRESS_HEALTH_OK" ]
[ "$(cat "$FAKE_AZ_ATTEMPT_FILE")" = "3" ]

printf '0' >"$FAKE_AZ_ATTEMPT_FILE"
export FAKE_AZ_SUCCEED_ON=2
export FAKE_AZ_ERROR='permission denied'
if azure_vm_run_command_with_retry --name worker >/dev/null 2>&1; then
  echo "non-transient Azure errors must fail closed" >&2
  exit 1
fi
[ "$(cat "$FAKE_AZ_ATTEMPT_FILE")" = "1" ]
