#!/usr/bin/env bash
set -euo pipefail

script=.github/scripts/configure-cloud-billing-admission.sh
workflow=.github/workflows/configure-cloud-billing-admission.yml
bash -n "$script"
grep -Fq 'case "$CLOUD_BILLING_MODE" in off|canary|public)' "$script"
grep -Fq 'git fetch --no-tags origin main' "$script"
grep -Fq '[ "$(git rev-parse origin/main)" = "$DEPLOY_SHA" ]' "$script"
grep -Fq 'current_image=$(az containerapp show' "$script"
grep -Fq '[ "$current_image" = "$WEB_IMAGE_DIGEST" ]' "$script"
grep -Fq '[ "$current_source_sha" = "$DEPLOY_SHA" ]' "$script"
grep -Fq 'POLAR_LOCAL_BILLING_ADMISSION=off' "$script"
grep -Fq 'RAZORPAY_LOCAL_BILLING_ADMISSION=off' "$script"
grep -Fq 'DEPLOY_PROBE_CERT_SHA256=$probe_fingerprint' "$script"
grep -Fq 'revision-weight "$previous_revision=100" "$candidate_revision=0"' "$script"
grep -Fq 'gh variable set POLAR_BILLING_ADMISSION --env azure-production' "$script"
grep -Fq 'gh variable set RAZORPAY_BILLING_ADMISSION --env azure-production' "$script"
grep -Fq 'gh variable set BILLING_CANARY_WORKSPACE_IDS --env azure-production' "$script"
grep -Fq 'gh variable delete BILLING_CANARY_WORKSPACE_IDS --env azure-production 2>/dev/null || true' "$script"
grep -Fq 'set_canary_allowlist "$BILLING_CANARY_WORKSPACE_IDS"' "$script"
grep -Fq 'if [ -n "$allowlist" ]; then' "$script"
grep -Fq 'az containerapp revision deactivate' "$script"
if grep -Fq -- '-H "Host: app.lyrashieldai.com"' "$script"; then
  echo 'FAIL: candidate readiness must use its Azure revision host.' >&2
  exit 1
fi
grep -Fq 'GH_TOKEN: ${{ secrets.ADMISSION_CONFIG_TOKEN }}' "$workflow"
grep -Fq 'options: ["off", canary, public]' "$workflow"
grep -Fq 'web_image_digest:' "$workflow"
grep -Fq 'source_sha:' "$workflow"
echo 'Cloud billing admission workflow static contract passed.'
