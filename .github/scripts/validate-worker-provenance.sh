#!/usr/bin/env bash
set -euo pipefail

digest="${1:?worker image digest is required}"
product_revision="${2:?product revision is required}"
engine_revision="${3:?engine revision is required}"

is_hex() {
  local value="$1"
  local length="$2"
  case "$value" in
    '' | *[!0-9a-fA-F]*) return 1 ;;
  esac
  [ "${#value}" -eq "$length" ]
}

case "$digest" in
  sha256:*) ;;
  *)
    echo "::error::Worker digest must be sha256:<64 hex>"
    exit 1
    ;;
esac
is_hex "${digest#sha256:}" 64 || {
  echo "::error::Worker digest must be sha256:<64 hex>"
  exit 1
}
is_hex "$product_revision" 40 || {
  echo "::error::Product revision must be a 40-character SHA"
  exit 1
}
is_hex "$engine_revision" 40 || {
  echo "::error::Engine revision must be a 40-character SHA"
  exit 1
}

if [ -n "${GITHUB_STEP_SUMMARY-}" ]; then
  {
    echo "Worker provenance record (worker VM runtime values):"
    echo "- LYRASHIELD_PRODUCT_REVISION=${product_revision}"
    echo "- LYRASHIELD_WORKER_IMAGE_DIGEST=${digest}"
    echo "- LYRASHIELD_ENGINE_REVISION=${engine_revision}"
    echo "The deploy job promotes this digest only after Container App smoke checks pass."
  } >>"$GITHUB_STEP_SUMMARY"
fi
