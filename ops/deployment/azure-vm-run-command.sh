#!/usr/bin/env bash

azure_vm_run_command_with_retry() {
  local attempt=1
  local max_attempts=6
  local result
  local status

  while [ "$attempt" -le "$max_attempts" ]; do
    set +e
    result=$(az vm run-command invoke "$@" 2>&1)
    status=$?
    set -e

    if [ "$status" -eq 0 ]; then
      printf '%s\n' "$result"
      return 0
    fi

    if printf '%s' "$result" | grep -Eq '\(Conflict\).*Run command extension execution is in progress|OperationInProgress'; then
      if [ "$attempt" -lt "$max_attempts" ]; then
        echo "::warning::Azure VM Run Command is busy (attempt ${attempt}/${max_attempts}); retrying in 10s." >&2
        sleep 10
        attempt=$((attempt + 1))
        continue
      fi
    fi

    printf '%s\n' "$result" >&2
    return "$status"
  done
}
