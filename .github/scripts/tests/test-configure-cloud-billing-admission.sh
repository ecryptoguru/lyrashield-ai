#!/usr/bin/env bash
set -euo pipefail

script=.github/scripts/configure-cloud-billing-admission.sh
workflow=.github/workflows/configure-cloud-billing-admission.yml
runtime_workflow=.github/workflows/deploy-azure-runtime.yml
bash -n "$script"
bash -n .github/scripts/read-cloud-billing-admission.sh
grep -Fq 'case "$CLOUD_BILLING_MODE" in off|canary|public)' "$script"
grep -Fq 'git fetch --no-tags origin main' "$script"
grep -Fq '[ "$(git rev-parse origin/main)" = "$DEPLOY_SHA" ]' "$script"
grep -Fq 'current_image=$(az containerapp revision show' "$script"
grep -Fq '[ "$current_image" = "$WEB_IMAGE_DIGEST" ]' "$script"
grep -Fq '[ "$current_source_sha" = "$DEPLOY_SHA" ]' "$script"
grep -Fq 'POLAR_LOCAL_BILLING_ADMISSION=off' "$script"
grep -Fq 'RAZORPAY_LOCAL_BILLING_ADMISSION=off' "$script"
grep -Fq 'DEPLOY_PROBE_CERT_SHA256=$probe_fingerprint' "$script"
grep -Fq 'revision-weight "$previous_revision=100" "$candidate_revision=0"' "$script"
grep -Fq 'for attempt in {1..12}; do' "$script"
grep -Fq 'candidate_ready=1' "$script"
grep -Fq '[ "$candidate_ready" -eq 1 ]' "$script"
grep -Fq 'previous_state=$(bash .github/scripts/read-cloud-billing-admission.sh "$previous_revision")' "$script"
grep -Fq 'current_state=$(bash .github/scripts/read-cloud-billing-admission.sh)' "$script"
grep -Fq 'az containerapp revision deactivate' "$script"
if grep -Fq -- '-H "Host: app.lyrashieldai.com"' "$script"; then
  echo 'FAIL: candidate readiness must use its Azure revision host.' >&2
  exit 1
fi
grep -Fq 'contents: read' "$workflow"
if grep -Fq 'contents: write' "$workflow" || grep -Fq 'GH_TOKEN:' "$workflow" || grep -Fq 'gh variable' "$script"; then
  echo 'FAIL: billing admission must use Azure OIDC and the live app revision, not GitHub variable writes.' >&2
  exit 1
fi
grep -Fq 'bash .github/scripts/read-cloud-billing-admission.sh >> "$GITHUB_ENV"' "$runtime_workflow"
if grep -Fq 'vars.POLAR_BILLING_ADMISSION' "$runtime_workflow" || grep -Fq 'vars.RAZORPAY_BILLING_ADMISSION' "$runtime_workflow"; then
  echo 'FAIL: deployment must preserve the live Cloud admission state.' >&2
  exit 1
fi
grep -Fq 'options: ["off", canary, public]' "$workflow"
grep -Fq 'web_image_digest:' "$workflow"
grep -Fq 'source_sha:' "$workflow"
echo 'Cloud billing admission workflow static contract passed.'

grep -Fq "if: github.ref == 'refs/heads/main'" "$workflow"
grep -Fq 'properties.configuration.ingress.traffic[?weight==' "$script"
grep -Fq "group: deploy-azure-\${{ vars.AZURE_RESOURCE_GROUP || 'production' }}-\${{ vars.AZURE_WORKER_VM_NAME || 'lyrashield-worker' }}" "$workflow"
grep -Fq "group: deploy-azure-\${{ vars.AZURE_RESOURCE_GROUP || 'production' }}-\${{ vars.AZURE_WORKER_VM_NAME || 'lyrashield-worker' }}" .github/workflows/deploy-azure.yml
grep -Fq 'revision-weight "$previous_revision=100" --output none || true' "$script"
