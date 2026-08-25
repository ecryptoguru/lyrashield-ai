#!/usr/bin/env bash

azure_vm_run_command_with_retry() {
  local attempt=1
  local max_attempts=6
  local error_file
  local error_output
  local result
  local status

  while [ "$attempt" -le "$max_attempts" ]; do
    error_file=$(mktemp)
    if result=$(timeout --foreground 180s az vm run-command invoke "$@" 2>"$error_file"); then
      status=0
    else
      status=$?
    fi
    error_output=$(cat "$error_file")
    rm -f "$error_file"

    if [ "$status" -eq 0 ]; then
      if [ -n "$error_output" ]; then
        printf '%s\n' "$error_output" >&2
      fi
      printf '%s\n' "$result"
      return 0
    fi

    if printf '%s\n%s' "$result" "$error_output" | grep -q 'Run command extension execution is in progress' &&
      printf '%s\n%s' "$result" "$error_output" | grep -Eq '\(Conflict\)|OperationInProgress'; then
      if [ "$attempt" -lt "$max_attempts" ]; then
        echo "::warning::Azure VM Run Command is busy (attempt ${attempt}/${max_attempts}); retrying in 10s." >&2
        sleep 10
        attempt=$((attempt + 1))
        continue
      fi
    fi

    printf '%s\n%s\n' "$result" "$error_output" >&2
    return "$status"
  done
}
