#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
source "$repo/ops/worker/worker-env.sh"
original=$(printf 'a%.0s' {1..64})
changed=$(printf 'b%.0s' {1..64})
cat > "$task_tmp/config" <<EOFCONFIG
LYRASHIELD_WORKER_IMAGE=ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:$original
LYRASHIELD_SANDBOX_IMAGE=ghcr.io/ecryptoguru/lyrashield-sandbox@sha256:$original
LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH=/etc/lyrashield/sandbox-publication-record.json
LYRASHIELD_COLD_SINGLE_WORKER=1
LYRASHIELD_COLD_DATABASE_EPOCH_SHA256=$original
LYRASHIELD_COLD_RELEASE_OWNER=42:1
EOFCONFIG
printf 'LYRASHIELD_COLD_SINGLE_WORKER=0\nLYRASHIELD_COLD_DATABASE_EPOCH_SHA256=%s\n' "$changed" > "$task_tmp/env"
docker() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; }
export LYRASHIELD_COLD_SINGLE_WORKER=0 LYRASHIELD_COLD_DATABASE_EPOCH_SHA256="$changed"
args=$(lyrashield_worker_env_args "$task_tmp/config" "$task_tmp/env")
grep -Fxq -- '--env LYRASHIELD_COLD_SINGLE_WORKER=1' <<< "$args"
grep -Fxq -- "--env LYRASHIELD_COLD_DATABASE_EPOCH_SHA256=$original" <<< "$args"
grep -Fxq -- '--env LYRASHIELD_COLD_RELEASE_OWNER=42:1' <<< "$args"
grep -Fxq -- '--env LYRASHIELD_WORKER_CONCURRENCY=1' <<< "$args"
[ "$(lyrashield_preserve_cold_epoch "$task_tmp/config" "$original")" = "$original" ]
if lyrashield_preserve_cold_epoch "$task_tmp/config" "$changed" >/dev/null 2>&1; then echo 'Changed database epoch was blessed' >&2; exit 1; fi
sed '/^LYRASHIELD_COLD_/d' "$task_tmp/config" > "$task_tmp/bootstrap"
[ "$(lyrashield_preserve_cold_epoch "$task_tmp/bootstrap" "$original")" = "$original" ]
args=$(lyrashield_worker_env_args "$task_tmp/bootstrap" "$task_tmp/env")
grep -Fxq -- '--env LYRASHIELD_COLD_SINGLE_WORKER=0' <<< "$args"
grep -Fxq -- '--env LYRASHIELD_COLD_DATABASE_EPOCH_SHA256=' <<< "$args"
sed '/^LYRASHIELD_COLD_DATABASE_EPOCH_SHA256=/d' "$task_tmp/config" > "$task_tmp/missing"
if lyrashield_worker_env_args "$task_tmp/missing" "$task_tmp/env" >/dev/null 2>&1; then echo 'Missing persisted pin emitted a container profile' >&2; exit 1; fi
if lyrashield_preserve_cold_epoch "$task_tmp/missing" "$changed" >/dev/null 2>&1; then echo 'Missing original pin was recaptured' >&2; exit 1; fi
printf 'Cold worker container environment and original epoch preservation passed.\n'
