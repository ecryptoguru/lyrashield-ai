#!/bin/sh
set -eu

: "${BILLING_STAGING_REGION:?BILLING_STAGING_REGION is required}"
: "${POLAR_ENVIRONMENT:?POLAR_ENVIRONMENT is required}"
: "${POLAR_ACCESS_TOKEN:?POLAR_ACCESS_TOKEN is required}"

[ "$BILLING_STAGING_REGION" = "usd" ]
[ "$POLAR_ENVIRONMENT" = "sandbox" ]

/app/e2e/billing/verify-staging-config.sh

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/../.." && pwd)
exec pnpm --filter @lyrashield/db exec tsx "$repo/e2e/billing/prepare-polar-checkout.ts"
