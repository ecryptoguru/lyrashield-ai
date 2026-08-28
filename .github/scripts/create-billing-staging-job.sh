#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <job-name> <image> <command> <replica-timeout>" >&2
  exit 64
fi

job_name=$1
image=$2
command=$3
replica_timeout=$4
replica_retry_limit=${JOB_REPLICA_RETRY_LIMIT:-0}
secret_specs=${JOB_SECRET_SPECS:-}
env_specs=${JOB_ENV_SPECS:-}

: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${CONTAINER_ENVIRONMENT:?CONTAINER_ENVIRONMENT is required}"
: "${REGISTRY:?REGISTRY is required}"
: "${PULL_IDENTITY_ID:?PULL_IDENTITY_ID is required}"
: "${IMAGE_SHA:?IMAGE_SHA is required}"

[[ "$job_name" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]]
[[ "$image" == "${REGISTRY}/"*"@sha256:"* ]]
[[ "$replica_timeout" =~ ^[1-9][0-9]*$ ]]
[[ "$replica_retry_limit" =~ ^[01]$ ]]

secrets='[]'
secret_refs='{}'
while IFS='=' read -r secret_name value_variable; do
  [ -n "$secret_name" ] || continue
  [[ "$secret_name" =~ ^[a-z][a-z0-9-]*[a-z0-9]$ ]]
  [[ "$value_variable" =~ ^[A-Z][A-Z0-9_]*$ ]]
  # Execution admission can retain a deleted job's logical secret alias. Bind
  # the physical alias to this immutable one-shot job resource.
  physical_secret_name="${secret_name}-${job_name}"
  secret_value=${!value_variable:?}
  secrets=$(jq -c \
    --arg name "$physical_secret_name" \
    --arg value "$secret_value" \
    '. + [{name: $name, value: $value}]' <<< "$secrets")
  secret_refs=$(jq -c \
    --arg logical_name "$secret_name" \
    --arg physical_name "$physical_secret_name" \
    '. + {($logical_name): $physical_name}' <<< "$secret_refs")
done <<< "$secret_specs"

container_env='[]'
initial_container_env='[]'
while IFS='=' read -r env_name env_value; do
  [ -n "$env_name" ] || continue
  [[ "$env_name" =~ ^[A-Z][A-Z0-9_]*$ ]]
  if [[ "$env_value" == secretref:* ]]; then
    logical_secret_ref=${env_value#secretref:}
    secret_ref=$(jq -er \
      --arg name "$logical_secret_ref" \
      '.[$name]' <<< "$secret_refs")
    container_env=$(jq -c \
      --arg name "$env_name" \
      --arg secret_ref "$secret_ref" \
      '. + [{name: $name, secretRef: $secret_ref}]' <<< "$container_env")
  else
    container_env=$(jq -c \
      --arg name "$env_name" \
      --arg value "$env_value" \
      '. + [{name: $name, value: $value}]' <<< "$container_env")
    initial_container_env=$(jq -c \
      --arg name "$env_name" \
      --arg value "$env_value" \
      '. + [{name: $name, value: $value}]' <<< "$initial_container_env")
  fi
done <<< "$env_specs"

subscription_id=$(az account show --query id --output tsv)
environment_id=$(az containerapp env show \
  --name "$CONTAINER_ENVIRONMENT" \
  --resource-group "$RESOURCE_GROUP" \
  --query id --output tsv)
location=$(az containerapp env show \
  --name "$CONTAINER_ENVIRONMENT" \
  --resource-group "$RESOURCE_GROUP" \
  --query location --output tsv)
job_url="https://management.azure.com/subscriptions/${subscription_id}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.App/jobs/${job_name}?api-version=2025-01-01"

# The Container Apps CLI attempts to create AcrPull even when the exact role
# already exists. Use the ARM job contract directly so least-privilege deploy
# identities never need Microsoft.Authorization/roleAssignments/write.
# Azure Jobs validates secret references before secrets included in the same
# create request are materialized. Persist the secrets first, then bind them.
body=$(jq -n \
  --arg location "$location" \
  --arg identity "$PULL_IDENTITY_ID" \
  --arg environment "$environment_id" \
  --arg registry "$REGISTRY" \
  --arg image "$image" \
  --arg name "$job_name" \
  --arg command "$command" \
  --argjson secrets "$secrets" \
  --argjson container_env "$initial_container_env" \
  --argjson timeout "$replica_timeout" \
  --argjson replica_retry_limit "$replica_retry_limit" \
  --arg source_sha "$IMAGE_SHA" \
  '{
    location: $location,
    tags: {environment: "billing-staging", "source-sha": $source_sha},
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {($identity): {}}
    },
    properties: {
      environmentId: $environment,
      configuration: {
        triggerType: "Manual",
        replicaTimeout: $timeout,
        replicaRetryLimit: $replica_retry_limit,
        manualTriggerConfig: {parallelism: 1, replicaCompletionCount: 1},
        registries: [{server: $registry, identity: $identity}],
        secrets: $secrets
      },
      template: {
        containers: [{name: $name, image: $image, command: [$command], env: $container_env}]
      }
    }
  }')

printf '%s' "$body" | az rest \
  --method put \
  --url "$job_url" \
  --headers 'Content-Type=application/json' \
  --body @- \
  --output none

wait_for_provisioning() {
  for _ in {1..60}; do
    provisioning_state=$(az containerapp job show \
      --name "$job_name" \
      --resource-group "$RESOURCE_GROUP" \
      --query properties.provisioningState --output tsv)
    case "$provisioning_state" in
      Succeeded) return 0 ;;
      Failed)
        echo "Container Apps job ${job_name} failed to provision." >&2
        return 1
        ;;
    esac
    sleep 5
  done

  echo "Timed out provisioning Container Apps job ${job_name}." >&2
  return 1
}

wait_for_provisioning

wait_for_secret_persistence() {
  local configured_secrets secret_name secrets_ready

  [ "$(jq 'length' <<< "$secrets")" -gt 0 ] || return 0
  for _ in {1..60}; do
    configured_secrets=" $(az containerapp job secret list \
      --name "$job_name" \
      --resource-group "$RESOURCE_GROUP" \
      --query '[].name' --output tsv | tr '\t\r\n' '   ') "
    secrets_ready=true
    while IFS= read -r secret_name; do
      [[ "$configured_secrets" == *" ${secret_name} "* ]] || {
        secrets_ready=false
        break
      }
    done < <(jq -r '.[].name' <<< "$secrets")
    $secrets_ready && return 0
    sleep 5
  done

  echo "Timed out persisting secrets for Container Apps job ${job_name}." >&2
  return 1
}

wait_for_secret_persistence

patch=$(jq -n \
  --arg image "$image" \
  --arg name "$job_name" \
  --arg command "$command" \
  --argjson container_env "$container_env" \
  '{properties: {template: {containers: [{name: $name, image: $image, command: [$command], env: $container_env}]}}}')

printf '%s' "$patch" | az rest \
  --method patch \
  --url "$job_url" \
  --headers 'Content-Type=application/json' \
  --body @- \
  --output none

wait_for_provisioning
