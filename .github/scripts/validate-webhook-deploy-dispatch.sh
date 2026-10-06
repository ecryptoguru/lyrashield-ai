#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_SHA:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_REF:?}"
if [ "$GITHUB_REF" != "refs/heads/main" ]; then
  echo "::error::Manual production dispatch workflow must run from refs/heads/main."
  exit 1
fi
if ! [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Manual production deployment requires a full current-main SHA."
  exit 1
fi

latest_main="$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq .object.sha)"
if [ "$SOURCE_SHA" != "$latest_main" ]; then
  echo "::error::Manual production deployment may only target current main."
  exit 1
fi
