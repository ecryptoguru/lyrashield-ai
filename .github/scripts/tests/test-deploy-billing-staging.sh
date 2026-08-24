#!/usr/bin/env bash
# Static contract literals intentionally retain shell and GitHub expressions.
# shellcheck disable=SC2016
set -euo pipefail

workflow="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/workflows/deploy-billing-staging.yml"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
migration_script="$repo/packages/db/scripts/run-billing-staging-migrations.sh"
role_script="$repo/packages/db/scripts/provision-billing-staging-roles.mjs"
proxy="$repo/apps/web/src/proxy.ts"
access_route="$repo/apps/web/src/app/api/staging/access/route.ts"
e2e_fixture="$repo/e2e/billing/fixtures.ts"

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
must_contain 'LYRASHIELD_DEPLOYMENT_ENVIRONMENT=billing-staging'
must_contain 'BILLING_STAGING_ADMISSION=restricted'
must_contain 'BILLING_STAGING_ACCESS_TOKEN=secretref:billing-staging-access'
must_contain 'lyrashield-web@${WEB_DIGEST}'
must_contain 'lyrashield-migrate@${MIGRATION_DIGEST}'
must_contain "app_runtime_staging"
must_contain "app_system_staging"
must_contain "access-restriction list"
must_contain "application-level staging gate"
must_contain "Checkout exact main revision"
must_contain 'ref: ${{ github.sha }}'
must_contain "Build and push exact-SHA staging web image"
must_contain "Build and push exact-SHA staging migration image"
must_contain "target: runner"
must_contain "target: workspace-builder"
must_contain 'org.opencontainers.image.revision=${{ env.IMAGE_SHA }}'
must_contain 'WEB_DIGEST: ${{ steps.build-web.outputs.digest }}'
must_contain 'MIGRATION_DIGEST: ${{ steps.build-migration.outputs.digest }}'
must_contain "Verify staging image provenance and owned job executables"
must_contain "Delete one-shot database jobs"
must_contain "az containerapp job delete"
must_contain "lyrashield-stage-migrate"
must_contain "lyrashield-stage-db-role"
must_contain "/app/packages/db/scripts/run-billing-staging-migrations.sh"
must_contain "/app/packages/db/scripts/provision-billing-staging-roles.mjs"
must_contain "DATABASE_SYSTEM_URL=secretref:database-system-url"
must_contain 'database-system-url=${system_database_url}'
must_contain 'DATABASE_ADMIN_URL: ${{ secrets.DATABASE_ADMIN_URL }}'
must_contain 'SYSTEM_PASSWORD: ${{ secrets.STAGING_DATABASE_SYSTEM_PASSWORD }}'
must_not_contain "azure-production"
must_not_contain "app_runtime_prod"
must_not_contain "ghcr.io"
must_not_contain '${{ secrets.DATABASE_SYSTEM_URL }}'
must_not_contain 'STAGING_WEB_DIGEST'
must_not_contain 'STAGING_MIGRATION_DIGEST'
must_not_contain 'STAGING_IMAGE_SHA'
must_not_contain "--args"
must_not_contain "--command /bin/sh"
must_not_contain "ROLE_SCRIPT="
must_not_contain "DATABASE_SYSTEM_URL=secretref:database-admin-url"
must_not_contain "POLAR_BILLING_ADMISSION=public"
must_not_contain "RAZORPAY_BILLING_ADMISSION=public"

test -x "$migration_script"
test -x "$role_script"
grep -Fq 'exec pnpm --filter @lyrashield/db exec prisma migrate deploy' "$migration_script"
grep -Fq 'const SYSTEM_ROLE = "app_system_staging"' "$role_script"
grep -Fq 'NOSUPERUSER' "$role_script"
grep -Fq 'NOBYPASSRLS' "$role_script"
grep -Fq 'NOREPLICATION' "$role_script"
grep -Fq 'rolreplication' "$role_script"
grep -Fq 'must not have role memberships' "$role_script"
grep -Fq 'PlatformAdminAudit' "$role_script"
grep -Fq 'SYSTEM_TABLES = ["License", "LicenseKey", "LicenseActivation"]' "$role_script"
grep -Fq 'privileges do not match the exact license-table contract' "$role_script"
grep -Fq '"License:DELETE"' "$role_script"
grep -Fq '"LicenseKey:UPDATE"' "$role_script"
if grep -Eq 'console\.(log|error).*PASSWORD|console\.(log|error).*password' "$role_script"; then
  echo "FAIL: role script may log a password" >&2
  exit 1
fi

if grep -E 'uses: [^@]+@(main|master|v[0-9]+)$' "$workflow"; then
  echo "FAIL: action is not SHA-pinned" >&2
  exit 1
fi

grep -Fq 'LYRASHIELD_DEPLOYMENT_ENVIRONMENT === "billing-staging"' "$proxy"
grep -Fq '"/billing/webhook"' "$proxy"
grep -Fq '"/api/ready"' "$proxy"
grep -Fq '!pathname.startsWith("/_next/static/")' "$proxy"
grep -Fq '!hasBillingStagingAccess(request)' "$proxy"
grep -Fq 'httpOnly: true' "$access_route"
grep -Fq 'secure: true' "$access_route"
grep -Fq 'sameSite: "lax"' "$access_route"
grep -Fq 'page.goto("/staging/access")' "$e2e_fixture"
grep -Fq 'getByLabel("Staging access code")' "$e2e_fixture"
if grep -Fq 'extraHTTPHeaders' "$e2e_fixture"; then
  echo "FAIL: staging access must not persist as a browser-wide header" >&2
  exit 1
fi

echo "Billing staging workflow static contract passed."
