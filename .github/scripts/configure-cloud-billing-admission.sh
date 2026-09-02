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
# The probe dir is created early: the allowlist read below needs a scratch
# file, and rollback() also references it from the trap.
probe_dir=$(mktemp -d)
# Capture the previous allowlist WITHOUT conflating "variable unset" (gh exits
# 1) with "gh call failed" (network/auth error exits 2+). A transient failure
# must not be read as an empty allowlist: rollback would then DELETE the
# production canary allowlist instead of restoring it.
previous_allowlist=""
set +e
gh variable get BILLING_CANARY_WORKSPACE_IDS --env azure-production >"$probe_dir/.allowlist" 2>/dev/null
allowlist_read_status=$?
set -e
if [ "$allowlist_read_status" = "0" ]; then
  previous_allowlist=$(cat "$probe_dir/.allowlist")
elif [ "$allowlist_read_status" = "1" ]; then
  previous_allowlist="" # genuinely unset — restoring emptiness is correct
else
  echo "ERROR: could not read BILLING_CANARY_WORKSPACE_IDS (gh failure); aborting before any mutation" >&2
  exit 1
fi
previous_revision=$(az containerapp show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query "properties.configuration.ingress.traffic[?weight==\`100\`].revisionName | [0]" --output tsv)
[ -n "$previous_revision" ] && [ "$previous_revision" != "None" ] && [ "$previous_revision" != "null" ] || { echo "No single 100%-traffic revision" >&2; exit 1; }
current_image=$(az containerapp revision show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision "$previous_revision" --query 'properties.template.containers[0].image' --output tsv)
current_source_sha=$(az containerapp revision show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision "$previous_revision" --query "properties.template.containers[0].env[?name=='LYRASHIELD_PRODUCT_REVISION'].value | [0]" --output tsv)
[ "$current_image" = "$WEB_IMAGE_DIGEST" ]
[ "$current_source_sha" = "$DEPLOY_SHA" ]
set_canary_allowlist() {
  local allowlist=$1
  if [ -n "$allowlist" ]; then
    gh variable set BILLING_CANARY_WORKSPACE_IDS --env azure-production --body "$allowlist" || return 1
  else
    gh variable delete BILLING_CANARY_WORKSPACE_IDS --env azure-production 2>/dev/null || true
  fi
}
restore_canary_allowlist() {
  set_canary_allowlist "$previous_allowlist" || true
}
rollback() {
  status=$?
  if [ "$status" -ne 0 ]; then
    # ORDER MATTERS: restore production traffic FIRST, then reconcile the
    # admission variables. Every step is || true guarded so one failed gh/az
    # call can never abort the trap before the remaining restorations run —
    # an unguarded failure here would leave traffic split on the candidate.
    az containerapp ingress traffic set --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision-weight "$previous_revision=100" --output none || true
    if [ -n "$candidate_revision" ] && [ "$candidate_revision" != "$previous_revision" ]; then
      az containerapp revision deactivate --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision "$candidate_revision" --output none || true
    fi
    gh variable set POLAR_BILLING_ADMISSION --env azure-production --body "$previous_polar" || true
    gh variable set RAZORPAY_BILLING_ADMISSION --env azure-production --body "$previous_razorpay" || true
    restore_canary_allowlist
  fi
  rm -rf "$probe_dir"
  exit "$status"
}

candidate_revision=""
trap rollback EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=lyrashield-deploy-probe" -keyout "$probe_dir/key.pem" -out "$probe_dir/cert.pem" >/dev/null 2>&1
probe_fingerprint=$(openssl x509 -in "$probe_dir/cert.pem" -outform DER | sha256sum | cut -d' ' -f1)

gh variable set POLAR_BILLING_ADMISSION --env azure-production --body "$CLOUD_BILLING_MODE"
gh variable set RAZORPAY_BILLING_ADMISSION --env azure-production --body "$CLOUD_BILLING_MODE"
set_canary_allowlist "$BILLING_CANARY_WORKSPACE_IDS"

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
candidate_ready=0
for attempt in {1..12}; do
  if curl --fail --silent --show-error --max-time 5 --cert "$probe_dir/cert.pem" --key "$probe_dir/key.pem" "https://${candidate_fqdn}/api/ready"; then
    candidate_ready=1
    break
  fi
  sleep 5
done
[ "$candidate_ready" -eq 1 ]
az containerapp ingress traffic set --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --revision-weight "$candidate_revision=100" --output none

az containerapp show --name "$AZURE_APP_CONTAINER_APP_NAME" --resource-group "$AZURE_RESOURCE_GROUP" --query '{revision:properties.latestRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}' --output json
trap - EXIT
rm -rf "$probe_dir"
