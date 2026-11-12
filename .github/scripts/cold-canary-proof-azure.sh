#!/usr/bin/env bash
set -euo pipefail
exec node .github/scripts/cold-release-azure.mjs proof "${1:?Canary proof payload required}"
