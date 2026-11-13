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
# AZURE_SECRET_SET_BACKOFF seconds (default 5, doubles to a 60-second cap), AZURE_SECRET_SET_TIMEOUT
# seconds per attempt (default 180).
azure_containerapp_secret_set_retrying() {
  local attempt=1
  local max_attempts="${AZURE_SECRET_SET_ATTEMPTS:-4}"
  local backoff="${AZURE_SECRET_SET_BACKOFF:-5}"
  local max_backoff=60
  local attempt_timeout="${AZURE_SECRET_SET_TIMEOUT:-180}"
  local output rc redacted

  if ! [[ "$max_attempts" =~ ^[0-9]+$ ]] || [ "$max_attempts" -lt 1 ]; then
    max_attempts=1
  fi
  if ! [[ "$backoff" =~ ^[0-9]+$ ]]; then
    backoff=5
  elif [ "$backoff" -gt "$max_backoff" ]; then
    backoff="$max_backoff"
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
    if [ "$backoff" -gt 30 ]; then
      backoff="$max_backoff"
    else
      backoff=$((backoff * 2))
    fi
    attempt=$((attempt + 1))
  done
}

# azure_keyvault_sync_env_group <vault-name> <secret-name:ENV_NAME...>
#
# Store GitHub Actions environment secrets in Key Vault without exposing their
# values in any child-process argv. The mapping arguments contain identifiers
# only. Files are private, are removed after each successful upload, and the
# source variables are unset before the first Azure CLI process is started.
# Azure diagnostics are intentionally suppressed on failure because a CLI
# exception must never be allowed to echo a secret value into workflow logs.
azure_keyvault_sync_env_group() {
  local vault_name="${1:-}"
  shift || true
  if [ -z "$vault_name" ] || [ "$#" -eq 0 ]; then
    echo "::error::Key Vault secret sync requires a vault and at least one name:environment mapping." >&2
    return 2
  fi

  local tmpdir mapping secret_name env_name value previous_exit_trap previous_exit_action previous_exit_quoted cleanup_command
  local -a mappings=("$@") secret_names=() env_names=() files=()
  for mapping in "${mappings[@]}"; do
    case "$mapping" in *:*) ;; *) echo "::error::Invalid Key Vault secret mapping." >&2; return 2 ;; esac
    secret_name="${mapping%%:*}"
    env_name="${mapping#*:}"
    if ! [[ "$secret_name" =~ ^[a-zA-Z0-9-]{1,127}$ ]] || ! [[ "$env_name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
      echo "::error::Invalid Key Vault secret mapping identifiers." >&2
      return 2
    fi
    value="${!env_name-}"
    if [ -z "$value" ]; then
      echo "::error::Required Key Vault secret environment value is missing." >&2
      return 1
    fi
    secret_names+=("$secret_name")
    env_names+=("$env_name")
  done

  umask 077
  tmpdir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/keyvault-secrets.XXXXXX") || return 1
  chmod 700 "$tmpdir"
  previous_exit_trap=$(trap -p EXIT)
  previous_exit_action=""
  if [ -n "$previous_exit_trap" ]; then
    previous_exit_quoted=${previous_exit_trap#trap -- }
    previous_exit_quoted=${previous_exit_quoted% EXIT}
    eval "previous_exit_action=$previous_exit_quoted"
  fi
  # The trap runs after this function has returned, so store a shell-quoted
  # literal path instead of expanding the function-local variable at exit.
  printf -v cleanup_command 'rm -rf -- %q' "$tmpdir"
  if [ -n "$previous_exit_trap" ]; then
    printf -v cleanup_command '%s; eval %q' "$cleanup_command" "$previous_exit_action"
  fi
  # Expand now so the EXIT action retains the path after local scope ends.
  # cleanup_command shell-quotes both the path and any prior trap action above.
  # shellcheck disable=SC2064
  trap -- "$cleanup_command" EXIT
  for index in "${!secret_names[@]}"; do
    secret_name="${secret_names[$index]}"
    env_name="${env_names[$index]}"
    value="${!env_name-}"
    printf '%s' "$value" >"$tmpdir/$secret_name"
    chmod 600 "$tmpdir/$secret_name"
    files+=("$tmpdir/$secret_name")
  done
  unset "${env_names[@]}"

  for index in "${!secret_names[@]}"; do
    secret_name="${secret_names[$index]}"
    if ! timeout --foreground "${AZURE_SECRET_SET_TIMEOUT:-180}s" az keyvault secret set \
      --vault-name "$vault_name" \
      --name "$secret_name" \
      --file "${files[$index]}" \
      --only-show-errors \
      --output none >/dev/null 2>&1; then
      echo "::error::Failed to sync Key Vault secret ${secret_name}." >&2
      return 1
    fi
    rm -f -- "${files[$index]}"
  done
  rm -rf -- "$tmpdir"
  if [ -n "$previous_exit_trap" ]; then eval "$previous_exit_trap"; else trap - EXIT; fi
}

# sync_secret_group <container-app-name> <secret-name=secretref...>
# Use this wrapper only with non-sensitive Key Vault references. Raw secret
# values must first go through azure_keyvault_sync_env_group.
sync_secret_group() {
  local container_app="${1:-}"
  shift || true
  if [ -z "$container_app" ] || [ "$#" -eq 0 ]; then
    echo "::error::Container App secret sync requires an app name and references." >&2
    return 2
  fi
  azure_containerapp_secret_set_retrying \
    --name "$container_app" \
    --resource-group "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}" \
    --secrets "$@" \
    --output none
}

# azure_keyvault_require_containerapp_access <vault-name> <resource-group> <app-name...>
# Verify each system identity can resolve Key Vault references and that the
# target vault is RBAC-enabled before any secret references are configured.
azure_keyvault_require_containerapp_access() {
  local vault_name="${1:-}" resource_group="${2:-}"
  shift 2 || true
  if [ -z "$vault_name" ] || [ -z "$resource_group" ] || [ "$#" -eq 0 ]; then
    echo "::error::Key Vault access validation requires a vault, resource group, and Container App." >&2
    return 2
  fi
  local vault_id rbac app principal role_count
  vault_id=$(az keyvault show --name "$vault_name" --query id --output tsv)
  rbac=$(az keyvault show --name "$vault_name" --query properties.enableRbacAuthorization --output tsv)
  if [ -z "$vault_id" ] || [ "$vault_id" = "None" ] || [ "$rbac" != "true" ]; then
    echo "::error::Key Vault ${vault_name} must exist and use Azure RBAC authorization." >&2
    return 1
  fi
  for app in "$@"; do
    [ -n "$app" ] || continue
    principal=$(az containerapp show --name "$app" --resource-group "$resource_group" --query identity.principalId --output tsv)
    if [ -z "$principal" ] || [ "$principal" = "None" ]; then
      echo "::error::${app} has no system-assigned identity for Key Vault references." >&2
      return 1
    fi
    role_count=$(az role assignment list \
      --scope "$vault_id" \
      --include-inherited \
      --assignee-object-id "$principal" \
      --query "[?roleDefinitionName=='Key Vault Secrets User'] | length(@)" \
      --output tsv)
    if ! [[ "$role_count" =~ ^[0-9]+$ ]] || [ "$role_count" -lt 1 ]; then
      echo "::error::${app} requires a Key Vault Secrets User grant on ${vault_name}. Provision the required role assignment separately; this deployment identity cannot create role assignments." >&2
      return 1
    fi
  done
}
