#!/usr/bin/env bash
set -euo pipefail

image_reference=${1:?worker image reference is required}
repository=${2:?expected worker repository is required}
repository="ghcr.io/${repository}/lyrashield-worker"

digest="${image_reference##*@}"
reference="${image_reference%@*}"
if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "worker image must be pinned by a full sha256 digest" >&2
  exit 1
fi
if [[ "$reference" != "$repository" ]]; then
  if [[ "$reference" != "$repository":* ]]; then
    echo "worker image repository does not match the expected GHCR repository" >&2
    exit 1
  fi
  tag="${reference#"$repository":}"
  if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "worker image tag is malformed" >&2
    exit 1
  fi
fi

printf '%s@%s\n' "$repository" "$digest"
