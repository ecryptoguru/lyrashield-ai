#!/usr/bin/env bash
set -euo pipefail

script=.github/scripts/validate-worker-provenance.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

digest="sha256:$(printf 'a%.0s' {1..64})"
product="$(printf 'b%.0s' {1..40})"
engine="$(printf 'c%.0s' {1..40})"

GITHUB_STEP_SUMMARY="$tmp/summary" bash "$script" "$digest" "$product" "$engine"
grep -Fq "LYRASHIELD_PRODUCT_REVISION=${product}" "$tmp/summary"
grep -Fq "LYRASHIELD_WORKER_IMAGE_DIGEST=${digest}" "$tmp/summary"
grep -Fq "LYRASHIELD_ENGINE_REVISION=${engine}" "$tmp/summary"

if bash "$script" "sha256:not-a-digest" "$product" "$engine" >/dev/null 2>&1; then
  echo "expected invalid worker digest to fail" >&2
  exit 1
fi
if bash "$script" "$digest" "not-a-sha" "$engine" >/dev/null 2>&1; then
  echo "expected invalid product revision to fail" >&2
  exit 1
fi
if bash "$script" "$digest" "$product" "not-a-sha" >/dev/null 2>&1; then
  echo "expected invalid engine revision to fail" >&2
  exit 1
fi

bash -n "$script"
echo "Worker provenance validation tests passed."
