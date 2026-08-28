#!/usr/bin/env bash
set -euo pipefail

: "${CLOUD_BILLING_MODE:?CLOUD_BILLING_MODE is required}"
: "${BILLING_CANARY_WORKSPACE_IDS-}"
: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
: "${AZURE_APP_CONTAINER_APP_NAME:?AZURE_APP_CONTAINER_APP_NAME is required}"
: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
: "${WEB_IMAGE_DIGEST:?WEB_IMAGE_DIGEST is required}"

case "$CLOUD_BILLING_MODE" in off|canary|public) ;; *) exit 1 ;; esac
case "$WEB_IMAGE_DIGEST" in ghcr.io/*@sha256:*) ;; *) exit 1 ;; esac
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
git fetch --no-tags origin main
[ "$(git rev-parse origin/main)" = "$DEPLOY_SHA" ]

IFS=, read -r -a workspace_ids <<< "$BILLING_CANARY_WORKSPACE_IDS"
if [ "$CLOUD_BILLING_MODE" = canary ]; then
  [ "${#workspace_ids[@]}" -gt 0 ]
  for workspace_id in "${workspace_ids[@]}"; do [[ "$workspace_id" =~ ^[A-Za-z0-9_-]{1,191}$ ]] || exit 1; done
else
  [ -z "$BILLING_CANARY_WORKSPACE_IDS" ]
fi

previous_polar=$(gh variable get POLAR_BILLING_ADMISSION --env azure-production)
previous_razorpay=$(gh variable get RAZORPAY_BILLING_ADMISSION --env azure-production)
previous_allowlist=$(gh variable get BILLING_CANARY_WORKSPACE_IDS --env azure-production 2>/dev/null || true)
previous_revision=$(az containerapp show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query properties.latestRevisionName --output tsv)
current_image=$(az containerapp show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query 'properties.template.containers[0].image' --output tsv)
current_source_sha=$(az containerapp show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query "properties.template.containers[0].env[?name=='LYRASHIELD_PRODUCT_REVISION'].value | [0]" --output tsv)
[ "$current_image" = "$WEB_IMAGE_DIGEST" ]
[ "$current_source_sha" = "$DEPLOY_SHA" ]
rollback() {
  status=$?
  if [ "$status" -ne 0 ]; then
    gh variable set POLAR_BILLING_ADMISSION --env azure-production --body "$previous_polar"
    gh variable set RAZORPAY_BILLING_ADMISSION --env azure-production --body "$previous_razorpay"
    gh variable set BILLING_CANARY_WORKSPACE_IDS --env azure-production --body "$previous_allowlist"
    az containerapp ingress traffic set --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision-weight "$previous_revision=100" --output none || true
  fi
  rm -rf "$probe_dir"
  exit "$status"
}

probe_dir=$(mktemp -d)
trap rollback EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=lyrashield-deploy-probe" -keyout "$probe_dir/key.pem" -out "$probe_dir/cert.pem" >/dev/null 2>&1
probe_fingerprint=$(openssl x509 -in "$probe_dir/cert.pem" -outform DER | sha256sum | cut -d' ' -f1)

gh variable set POLAR_BILLING_ADMISSION --env azure-production --body "$CLOUD_BILLING_MODE"
gh variable set RAZORPAY_BILLING_ADMISSION --env azure-production --body "$CLOUD_BILLING_MODE"
gh variable set BILLING_CANARY_WORKSPACE_IDS --env azure-production --body "$BILLING_CANARY_WORKSPACE_IDS"

az containerapp update --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --image "$WEB_IMAGE_DIGEST" --set-env-vars \
  "LYRASHIELD_PRODUCT_REVISION=$DEPLOY_SHA" \
  "POLAR_BILLING_ADMISSION=$CLOUD_BILLING_MODE" \
  "RAZORPAY_BILLING_ADMISSION=$CLOUD_BILLING_MODE" \
  "BILLING_CANARY_WORKSPACE_IDS=$BILLING_CANARY_WORKSPACE_IDS" \
  "POLAR_LOCAL_BILLING_ADMISSION=off" \
  "RAZORPAY_LOCAL_BILLING_ADMISSION=off" \
  "DEPLOY_PROBE_CERT_SHA256=$probe_fingerprint" --output none

candidate_revision=$(az containerapp show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query properties.latestRevisionName --output tsv)
candidate_fqdn=$(az containerapp revision show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision "$candidate_revision" --query properties.fqdn --output tsv)
[ -n "$candidate_revision" ] && [ -n "$candidate_fqdn" ]
az containerapp ingress traffic set --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision-weight "$previous_revision=100" "$candidate_revision=0" --output none
curl --fail --silent --show-error --max-time 15 --cert "$probe_dir/cert.pem" --key "$probe_dir/key.pem" -H "Host: app.lyrashieldai.com" "https://${candidate_fqdn}/api/ready"
az containerapp ingress traffic set --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision-weight "$candidate_revision=100" --output none

az containerapp show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query '{revision:properties.latestRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' --output json
trap - EXIT
rm -rf "$probe_dir"
