#!/usr/bin/env bash
set -euo pipefail

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/workflows/deploy-billing-staging.yml"

must_contain() {
  grep -Fq -- "$1" "$workflow" || {
    echo "FAIL: missing $1" >&2
    exit 1
  }
}

must_not_contain() {
  if grep -Fq -- "$1" "$workflow"; then
    echo "FAIL: forbidden $1" >&2
    exit 1
  fi
}

must_contain "environment:"
must_contain "name: billing-staging"
must_contain "id-token: write"
must_contain 'POLAR_BILLING_ADMISSION=off'
must_contain 'RAZORPAY_BILLING_ADMISSION=off'
must_contain 'POLAR_LOCAL_BILLING_ADMISSION=off'
must_contain 'RAZORPAY_LOCAL_BILLING_ADMISSION=off'
must_contain 'lyrashield-web@${WEB_DIGEST}'
must_contain 'lyrashield-migrate@${MIGRATION_DIGEST}'
must_contain "app_runtime_staging"
must_contain "NOSUPERUSER"
must_contain "NOBYPASSRLS"
must_contain "PlatformAdminAudit"
must_contain "access-restriction list"
must_contain "publicly reachable for provider webhook delivery"
must_contain "Delete one-shot database jobs"
must_contain "az containerapp job delete"
must_contain "lyrashield-stage-migrate"
must_contain "lyrashield-stage-db-role"
must_not_contain "azure-production"
must_not_contain "app_runtime_prod"
must_not_contain "ghcr.io"
must_not_contain '"db-system-url=${DATABASE_SYSTEM_URL}"'
must_not_contain "POLAR_BILLING_ADMISSION=public"
must_not_contain "RAZORPAY_BILLING_ADMISSION=public"

if grep -E 'uses: [^@]+@(main|master|v[0-9]+)$' "$workflow"; then
  echo "FAIL: action is not SHA-pinned" >&2
  exit 1
fi

echo "Billing staging workflow static contract passed."
