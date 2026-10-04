#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_SHA:?}" "${CONFIRMATION:?}" "${WEBHOOK_CLAIMS_CUTOVER:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_OUTPUT:?}"
echo "recovery_requires_receipt=false" >> "$GITHUB_OUTPUT"

expected_confirmation="deploy:${SOURCE_SHA}"
if [ "$WEBHOOK_CLAIMS_CUTOVER" = true ]; then
  expected_confirmation="webhook-cutover:${SOURCE_SHA}"
fi
if ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || [ "$CONFIRMATION" != "$expected_confirmation" ]; then
  if [ "$WEBHOOK_CLAIMS_CUTOVER" = true ]; then
    echo "::error::First webhook cutover requires current main SHA and exact confirmation webhook-cutover:${SOURCE_SHA}; do not use a normal release to bootstrap it."
  else
    echo "::error::Manual production deployment requires current main SHA and exact confirmation deploy:${SOURCE_SHA}."
  fi
  exit 1
fi

latest_main="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq .object.sha)"
if [ "$SOURCE_SHA" = "$latest_main" ]; then
  exit 0
fi

if [ "$GITHUB_RUN_ATTEMPT" -gt 1 ] && [ "$WEBHOOK_CLAIMS_CUTOVER" = true ]; then
  original_validation="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/1/jobs" \
    --jq '.jobs[] | select(.name == "Validate emergency production dispatch") | .conclusion')"
  if [ "$original_validation" != success ]; then
    echo "::error::Maintenance recovery requires successful original dispatch validation."
    exit 1
  fi
  echo "recovery_requires_receipt=true" >> "$GITHUB_OUTPUT"
  echo "Recovering the original approved immutable source in the same GitHub run."
  exit 0
fi

echo "::error::Manual production deployment may only target current main."
exit 1
