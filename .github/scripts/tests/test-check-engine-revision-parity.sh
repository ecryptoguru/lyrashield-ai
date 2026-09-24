#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="$repo/.github/scripts/check-engine-revision-parity.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

revision=1b98b8f7fb1e84913e34c23a898429481df01570
other=2c8fccc9d1b0b1f0e3e0c9a0b1c2d3e4f5a6b7c8

write_workflow() {
  local path=$1 pinned=$2
  printf 'env:\n  ENGINE_REVISION: %s\n' "$pinned" > "$path"
}

# The live workflows agree on the pin, so the check passes and names it.
bash "$script" .github/workflows/deploy-azure.yml .github/workflows/release-tauri.yml

# A mismatch fails and names both revisions.
mkdir -p "$tmp/case/.github/workflows"
write_workflow "$tmp/case/.github/workflows/deploy-azure.yml" "$revision"
write_workflow "$tmp/case/.github/workflows/release-tauri.yml" "$other"
if mismatch_output=$(LYRASHIELD_REPO_ROOT="$tmp/case" bash "$script" .github/workflows/deploy-azure.yml .github/workflows/release-tauri.yml 2>&1); then
  echo "expected mismatched ENGINE_REVISION to fail" >&2
  exit 1
fi
grep -Fq "ENGINE_REVISION mismatch" <<< "$mismatch_output"
grep -Fq "$revision" <<< "$mismatch_output"
grep -Fq "$other" <<< "$mismatch_output"

# A missing pin in one workflow fails rather than silently agreeing.
printf 'env:\n' > "$tmp/case/.github/workflows/release-tauri.yml"
if LYRASHIELD_REPO_ROOT="$tmp/case" bash "$script" .github/workflows/deploy-azure.yml .github/workflows/release-tauri.yml >/dev/null 2>&1; then
  echo "expected a workflow without ENGINE_REVISION to fail" >&2
  exit 1
fi

# A duplicate pin fails rather than letting the first value win.
{
  printf 'env:\n  ENGINE_REVISION: %s\n' "$revision"
  printf '  ENGINE_REVISION: %s\n' "$other"
} > "$tmp/case/.github/workflows/release-tauri.yml"
if LYRASHIELD_REPO_ROOT="$tmp/case" bash "$script" .github/workflows/deploy-azure.yml .github/workflows/release-tauri.yml >/dev/null 2>&1; then
  echo "expected a duplicate ENGINE_REVISION to fail" >&2
  exit 1
fi

bash -n "$script"
echo "Engine revision parity tests passed."
