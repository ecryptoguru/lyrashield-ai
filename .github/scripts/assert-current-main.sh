#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_SHA:?SOURCE_SHA is required}" "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
if ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Deployment source must be a full 40-character commit SHA."
  exit 1
fi

if ! checkout_sha=$(git rev-parse HEAD 2>/dev/null) || [ "$checkout_sha" != "$SOURCE_SHA" ]; then
  echo "::error::Checkout does not match the requested deployment source SHA."
  exit 1
fi

if ! latest_main=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq .object.sha); then
  echo "::error::Could not read the current main SHA."
  exit 1
fi
if ! [[ "$latest_main" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::GitHub returned an invalid current main SHA."
  exit 1
fi
if [ "$SOURCE_SHA" != "$latest_main" ]; then
  echo "::error::Release source may only target current main; the queued current-main release must perform the deployment."
  exit 1
fi
