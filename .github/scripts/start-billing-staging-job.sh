#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <job-name> <resource-group>" >&2
  exit 64
fi

job_name=$1
resource_group=$2
[[ "$job_name" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]]

start_error=$(mktemp)
trap 'rm -f "$start_error"' EXIT

for _ in {1..60}; do
  if execution=$(az containerapp job start \
    --name "$job_name" \
    --resource-group "$resource_group" \
    --query name --output tsv 2>"$start_error"); then
    [ -n "$execution" ] || {
      echo "Container Apps returned an empty execution name for ${job_name}." >&2
      exit 1
    }
    printf '%s\n' "$execution"
    exit 0
  fi
  if grep -Fq 'ContainerAppSecretRefNotFound' "$start_error"; then
    sleep 5
    continue
  fi
  cat "$start_error" >&2
  exit 1
done

cat "$start_error" >&2
echo "Timed out waiting for Azure to admit ${job_name}'s persisted secret references." >&2
exit 1
