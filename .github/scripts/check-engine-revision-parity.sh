#!/usr/bin/env bash
# Assert the ENGINE_REVISION pin is identical in every release workflow that
# builds or deploys the worker. The app's ENGINE_REVISION pin is verified
# against the engine repository by verify-engine-revision.sh; this check only
# proves the workflows agree on which revision that pin names.
#
# Usage: check-engine-revision-parity.sh [workflow ...]
# Defaults to deploy-azure.yml and release-tauri.yml.
set -euo pipefail

repo_root="${LYRASHIELD_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

if [ "$#" -gt 0 ]; then
  workflows=("$@")
else
  workflows=(.github/workflows/deploy-azure.yml .github/workflows/release-tauri.yml)
fi

read_revision() {
  local workflow=$1
  local path="$repo_root/$workflow"
  if [ ! -f "$path" ]; then
    echo "::error::$workflow is missing"
    exit 1
  fi
  # The pin is a top-level env key two spaces deep. Match exactly one so a
  # duplicate directive cannot pass unnoticed.
  local revisions
  revisions=$(sed -nE 's/^  ENGINE_REVISION: ([0-9a-f]{40})$/\1/p' "$path")
  local count
  count=$(printf '%s\n' "$revisions" | grep -c . || true)
  if [ "$count" -ne 1 ]; then
    echo "::error::$workflow must contain exactly one 40-character ENGINE_REVISION"
    exit 1
  fi
  printf '%s\n' "$revisions"
}

reference_workflow=${workflows[0]}
reference_revision=$(read_revision "$reference_workflow")

for workflow in "${workflows[@]:1}"; do
  revision=$(read_revision "$workflow")
  if [ "$revision" != "$reference_revision" ]; then
    echo "::error::ENGINE_REVISION mismatch: $reference_workflow pins $reference_revision but $workflow pins $revision"
    exit 1
  fi
done

echo "ENGINE_REVISION matches across ${workflows[*]}: $reference_revision"
