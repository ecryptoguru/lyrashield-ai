#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_SHA:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_REF:?}"
if [ "$GITHUB_REF" != "refs/heads/main" ]; then
  echo "::error::Manual production dispatch workflow must run from refs/heads/main."
  exit 1
fi
bash .github/scripts/assert-current-main.sh
