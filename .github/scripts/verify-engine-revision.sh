#!/usr/bin/env bash
set -euo pipefail

engine_dir="${1:?engine checkout path is required}"
revision="${2:?engine revision is required}"
repository="${3:?engine repository is required}"

if ! [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "engine revision must be an immutable 40-character commit SHA" >&2
  exit 1
fi

git -C "$engine_dir" fetch --no-tags origin main:refs/remotes/origin/main
if ! git -C "$engine_dir" merge-base --is-ancestor "$revision" origin/main; then
  echo "engine revision $revision is not merged into $repository main" >&2
  exit 1
fi

checks_endpoint="repos/$repository/commits/$revision/check-runs"
for check_name in "verify" "Build and smoke-test sandbox image"; do
  if [ "$(gh api "$checks_endpoint" --jq "any(.check_runs[]; .name == \"$check_name\" and .status == \"completed\" and .conclusion == \"success\")")" != "true" ]; then
    echo "engine revision $revision does not have a successful '$check_name' check" >&2
    exit 1
  fi
done
