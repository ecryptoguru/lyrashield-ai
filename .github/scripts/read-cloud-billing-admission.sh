#!/usr/bin/env bash
set -euo pipefail

: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
: "${AZURE_APP_CONTAINER_APP_NAME:?AZURE_APP_CONTAINER_APP_NAME is required}"

revision=${1:-}
if [ -z "$revision" ]; then
  revision=$(az containerapp show \
    --name "$AZURE_APP_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --query 'properties.configuration.ingress.traffic[?weight==`100`].revisionName' \
    --output tsv)
fi
[[ "$revision" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]] || {
  echo "No single 100%-traffic app revision" >&2
  exit 1
}

az containerapp revision show \
  --name "$AZURE_APP_CONTAINER_APP_NAME" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --revision "$revision" \
  --query 'properties.template.containers[0].env' \
  --output json | node .github/scripts/parse-cloud-billing-admission.mjs
