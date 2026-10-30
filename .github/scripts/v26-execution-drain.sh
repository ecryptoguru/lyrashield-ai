#!/bin/sh
# Read-only check: a stopped worker does not prove its sandbox children stopped.
set -eu

if ! sandbox_containers=$(timeout 10s docker ps --quiet --filter 'label=strix-run-id' 2>/dev/null); then
  echo 'v26 sandbox execution state unavailable' >&2
  exit 1
fi
if [ -n "$sandbox_containers" ]; then
  echo 'v26 sandbox execution remains active' >&2
  exit 1
fi
if ! resolver_containers=$(timeout 10s docker ps --quiet --filter 'name=lyrashield-go-' 2>/dev/null); then
  echo 'v26 resolver execution state unavailable' >&2
  exit 1
fi
if [ -n "$resolver_containers" ]; then
  echo 'v26 resolver execution remains active' >&2
  exit 1
fi
echo V26_EXECUTION_DRAIN_VERIFIED
