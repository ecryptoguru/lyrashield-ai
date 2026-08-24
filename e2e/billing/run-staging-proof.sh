#!/bin/sh
set -eu

: "${BILLING_STAGING_REGION:?BILLING_STAGING_REGION is required}"
: "${BILLING_E2E_DATABASE_URL:?BILLING_E2E_DATABASE_URL is required}"
: "${LYRASHIELD_E2E_BASE_URL:?LYRASHIELD_E2E_BASE_URL is required}"

case "$BILLING_STAGING_REGION" in
  usd)
    export POLAR_TEST_MODE=1
    export RAZORPAY_TEST_MODE=0
    ;;
  inr)
    export POLAR_TEST_MODE=0
    export RAZORPAY_TEST_MODE=1
    ;;
  *)
    echo "BILLING_STAGING_REGION must be usd or inr" >&2
    exit 1
    ;;
esac

# Fail before opening a browser or contacting a provider when the one-shot job
# does not satisfy the same validated runtime configuration as the staged app.
/app/e2e/billing/verify-staging-config.sh

exec pnpm exec playwright test \
  e2e/billing/checkout-flows.spec.ts \
  e2e/billing/razorpay-upi-cap-fallback.spec.ts \
  --project=chromium
