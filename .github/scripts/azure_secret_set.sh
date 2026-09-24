#!/usr/bin/env bash
#
# Azure Container Apps secret-sync helper for deploy-azure.yml.
#
# Sourced (not executed) by the deploy job's secret-sync steps:
#
#   source .github/scripts/azure_secret_set.sh
#   azure_containerapp_secret_set_retrying \
#     --name "$APP" --resource-group "$RG" --secrets "k=v" || {
#       echo "::error::Failed to sync ..."; exit 1;
#     }
#
# Why this exists (2026-09-25): production release run 36061999137 aborted the
# entire rollout — every deploy, smoke, promote and traffic step skipped — on
# `Failed to sync Myra secret myra-g-refresh`. The same step had succeeded twice
# earlier the same day with identical inputs, so the failure was a transient
# Azure blip. Two things turned a blip into a blocked release:
#
#   1. `--only-show-errors` suppresses cli output, and the call was wrapped in a
#      capturless `timeout`, so a failure emitted NO diagnostic at all — a
#      timeout, a throttled ARM call and a genuinely bad credential are
#      indistinguishable in the log.
#   2. There was no retry, so the first transient error failed the step, and the
#      step failed the job, and the job failed the release.
#
# This helper retries the calls that can transiently fail, and on a final
# failure prints the captured CLI output so the next failure is diagnosable.
#
# Non-retryable failures (bad credential, permission denied, validation) still
# fail immediately — retrying those only delays a real error.

# Azure CLI / ARM signatures that indicate a transient condition. Matched
# case-insensitively as fixed strings so an error code substring cannot be
# missed by regex escaping.
AZURE_SECRET_SET_RETRYABLE_SIGNATURES=(
  'ContainerAppOperationInProgress'
  'OperationInProgress'
  'Another operation is in progress'
  'conflict'
  'TooManyRequests'
  'RequestTimeout'
  'ServerTimeout'
  'ServiceUnavailable'
  'InternalServerError'
  'Bad Gateway'
  'GatewayTimeout'
  'Connection reset'
  'Connection aborted'
  'ConnectionError'
  'NewConnectionError'
  'Max retries exceeded'
  'Temporary failure'
  'timed out'
  'Timeout'
)

# True when the captured output (and/or exit code) indicates a retryable
# condition. $1 = captured output, $2 = exit code.
azure_secret_set_is_retryable() {
  local text="$1" rc="$2" sig
  # `timeout` kills the process with 124; a hung ARM call is transient by
  # definition and must be retried even though it prints nothing.
  if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then
    return 0
  fi
  for sig in "${AZURE_SECRET_SET_RETRYABLE_SIGNATURES[@]}"; do
    if printf '%s' "$text" | grep -Fqi -- "$sig"; then
      return 0
    fi
  done
  # az surfaces low-level connection blips as a python traceback with no HTTP
  # status line, so match the exception classes directly.
  if printf '%s' "$text" | grep -Eq 'requests\.exceptions|urllib3|socket\.timeout|Token issuer'; then
    return 0
  fi
  return 1
}

# Replace any known secret value with a placeholder. Azure does not normally
# echo a request body, but the surfaced diagnostic must never be the path by
# which a credential reaches a CI log. Values shorter than 8 characters are
# skipped (too likely to appear as an incidental substring), and multi-line
# values (a PEM private key) are skipped because a literal replacement across
# newlines is not reliable.
azure_secret_set_redact() {
  local text="$1"
  shift
  local value
  for value in "$@"; do
    [ "${#value}" -ge 8 ] || continue
    case "$value" in *$'\n'*) continue ;; esac
    text=${text//"$value"/"[redacted]"}
  done
  printf '%s' "$text"
}

# Collect the secret VALUES from a `--secrets k=v [k=v ...]` argument vector so
# they can be redacted out of any diagnostic. Args are read positionally:
# everything after `--secrets` up to the next `--flag` is a `k=v` pair.
azure_secret_set_values_from_args() {
  local collecting=0 arg
  for arg in "$@"; do
    if [ "$collecting" = "1" ]; then
      case "$arg" in
        --*)
          collecting=0
          ;;
        *=*)
          printf '%s\n' "${arg#*=}"
          continue
          ;;
        *)
          continue
          ;;
      esac
    fi
    case "$arg" in
      --secrets) collecting=1 ;;
      --secrets=*) printf '%s\n' "${arg#--secrets=}" ;;
    esac
  done
}

# azure_containerapp_secret_set_retrying <az containerapp secret set args...>
#
# Successful call: returns 0. Emits the CLI output on stdout when non-empty so
# a caller can consume a --query result.
# Failed call: returns the last exit code, with the captured diagnostic on
# stderr (secret values redacted) so `--only-show-errors` can no longer swallow
# the reason.
#
# Tunables (env): AZURE_SECRET_SET_ATTEMPTS (default 4),
# AZURE_SECRET_SET_BACKOFF seconds (default 5), AZURE_SECRET_SET_TIMEOUT
# seconds per attempt (default 180).
azure_containerapp_secret_set_retrying() {
  local attempt=1
  local max_attempts="${AZURE_SECRET_SET_ATTEMPTS:-4}"
  local backoff="${AZURE_SECRET_SET_BACKOFF:-5}"
  local attempt_timeout="${AZURE_SECRET_SET_TIMEOUT:-180}"
  local output rc redacted

  if ! [[ "$max_attempts" =~ ^[0-9]+$ ]] || [ "$max_attempts" -lt 1 ]; then
    max_attempts=1
  fi

  # Capture the secret values once so every diagnostic path can redact them.
  local -a secret_values=()
  while IFS= read -r value; do
    [ -n "$value" ] && secret_values+=("$value")
  done < <(azure_secret_set_values_from_args "$@")

  while :; do
    # Disable -e for the capture so a failing call is inspected, not fatal.
    set +e
    output=$(timeout --foreground "${attempt_timeout}s" az containerapp secret set \
      --only-show-errors "$@" 2>&1)
    rc=$?
    set -e

    if [ "$rc" -eq 0 ]; then
      if [ -n "$output" ]; then
        printf '%s\n' "$output"
      fi
      return 0
    fi

    redacted=$(azure_secret_set_redact "$output" ${secret_values[@]+"${secret_values[@]}"})

    if [ "$attempt" -ge "$max_attempts" ] || ! azure_secret_set_is_retryable "$output" "$rc"; then
      printf '%s\n' "$redacted" >&2
      echo "::error::az containerapp secret set failed after ${attempt} attempt(s) (exit ${rc})." >&2
      return "$rc"
    fi

    # stderr, not stdout: a caller may capture stdout for a --query result, and
    # a retry warning must never contaminate it.
    echo "::warning::az containerapp secret set failed (attempt ${attempt}/${max_attempts}, exit ${rc}); retrying in ${backoff}s. ${redacted%%$'\n'*}" >&2
    sleep "$backoff"
    attempt=$((attempt + 1))
  done
}
