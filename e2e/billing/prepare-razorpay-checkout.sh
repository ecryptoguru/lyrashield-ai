#!/bin/sh
set -eu

: "${BILLING_STAGING_REGION:?BILLING_STAGING_REGION is required}"
: "${RAZORPAY_KEY_ID:?RAZORPAY_KEY_ID is required}"

[ "$BILLING_STAGING_REGION" = "inr" ]
case "$RAZORPAY_KEY_ID" in rzp_test_*) ;; *) exit 1 ;; esac

/app/e2e/billing/verify-staging-config.sh

repo=$(unset CDPATH; cd -- "$(dirname -- "$0")/../.." && pwd)
exec pnpm --filter @lyrashield/db exec tsx "$repo/e2e/billing/prepare-razorpay-checkout.ts"
