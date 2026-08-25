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
if [ -n "${FAKE_AZ_SUCCESS_WARNING:-}" ]; then
  printf '%s\n' "$FAKE_AZ_SUCCESS_WARNING" >&2
fi
printf 'EGRESS_HEALTH_OK\n'
EOF
chmod +x "$test_dir/az"

cat >"$test_dir/timeout" <<'EOF'
#!/bin/sh
set -eu
if [ -n "${FAKE_TIMEOUT_STATUS:-}" ]; then
  exit "$FAKE_TIMEOUT_STATUS"
fi
[ "$1" = "--foreground" ]
shift 2
exec "$@"
EOF
chmod +x "$test_dir/timeout"

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
export FAKE_AZ_SUCCESS_WARNING='azure warning remains visible'
warning_file="$test_dir/warning"
result=$(azure_vm_run_command_with_retry --name worker 2>"$warning_file")
[ "$result" = "EGRESS_HEALTH_OK" ]
[ "$(cat "$FAKE_AZ_ATTEMPT_FILE")" = "3" ]
grep -q 'azure warning remains visible' "$warning_file"
unset FAKE_AZ_SUCCESS_WARNING

printf '0' >"$FAKE_AZ_ATTEMPT_FILE"
export FAKE_AZ_SUCCEED_ON=2
export FAKE_AZ_ERROR='permission denied'
if azure_vm_run_command_with_retry --name worker >/dev/null 2>&1; then
  echo "non-transient Azure errors must fail closed" >&2
  exit 1
fi
[ "$(cat "$FAKE_AZ_ATTEMPT_FILE")" = "1" ]

printf '0' >"$FAKE_AZ_ATTEMPT_FILE"
export FAKE_AZ_SUCCEED_ON=7
export FAKE_AZ_ERROR='OperationInProgress: Run command extension execution is in progress'
if azure_vm_run_command_with_retry --name worker >/dev/null 2>&1; then
  echo "busy Azure errors must stop after six attempts" >&2
  exit 1
fi
[ "$(cat "$FAKE_AZ_ATTEMPT_FILE")" = "6" ]

printf '0' >"$FAKE_AZ_ATTEMPT_FILE"
export FAKE_TIMEOUT_STATUS=124
if azure_vm_run_command_with_retry --name worker >/dev/null 2>&1; then
  echo "timed-out Azure calls must fail closed" >&2
  exit 1
fi
[ "$(cat "$FAKE_AZ_ATTEMPT_FILE")" = "0" ]
