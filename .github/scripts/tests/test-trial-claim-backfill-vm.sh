#!/usr/bin/env bash
set -euo pipefail

# Regression: the production worker image intentionally has no pnpm or source
# checkout. This host runner must create an isolated one-shot container, copy
# the reviewed backfill script into the deployed db package, and reject every
# mutation spelling except the pinned confirmation flag.

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
runner="$repo/ops/worker/trial-claim-backfill.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ ! -x "$runner" ]; then
  echo "trial-claim VM runner is missing or not executable" >&2
  exit 1
fi

app_revision=$(printf 'a%.0s' {1..40})
engine_revision=$(printf 'b%.0s' {1..40})
image="ghcr.io/example/worker@sha256:$(printf 'c%.0s' {1..64})"

mkdir -p "$tmp/bin" "$tmp/assets"
printf 'reviewed backfill source\n' > "$tmp/assets/backfill-clear-wrong-trial-claims.ts"
printf 'LYRASHIELD_WORKER_IMAGE=%s\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:%s\n' \
  "$image" "$(printf 'd%.0s' {1..64})" > "$tmp/runtime.conf"
printf 'DATABASE_SYSTEM_URL=postgresql://system@example.invalid/lyrashield\n' > "$tmp/worker.env"

cat > "$tmp/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$1:${2:-}" in
  image:inspect)
    case "$*" in
      *org.opencontainers.image.revision*) printf '%s\n' "$MOCK_APP_REVISION" ;;
      *io.lyrashield.engine.revision*) printf '%s\n' "$MOCK_ENGINE_REVISION" ;;
      *) exit 1 ;;
    esac ;;
  create:*) printf 'trial-backfill-container\n' ;;
  cp:*)
    [ "$2" = "$MOCK_SOURCE" ]
    [ "$3" = 'trial-backfill-container:/app/apps/worker/node_modules/@lyrashield/db/scripts/backfill-clear-wrong-trial-claims.ts' ] ;;
  start:*) printf '{"candidates":[],"cleared":0,"unaudited":[],"applied":false}\n' ;;
  rm:*) : ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 1 ;;
esac
MOCK
chmod +x "$tmp/bin/docker"

run_runner() {
  PATH="$tmp/bin:$PATH" \
    MOCK_DOCKER_LOG="$tmp/docker.log" \
    MOCK_SOURCE="$tmp/assets/backfill-clear-wrong-trial-claims.ts" \
    MOCK_APP_REVISION="$app_revision" \
    MOCK_ENGINE_REVISION="$engine_revision" \
    LYRASHIELD_WORKER_RUNTIME_CONFIG="$tmp/runtime.conf" \
    LYRASHIELD_WORKER_ENV_FILE="$tmp/worker.env" \
    LYRASHIELD_WORKER_ENV_LIB="$repo/ops/worker/worker-env.sh" \
    LYRASHIELD_WORKER_HOST_ASSETS_DIR="$tmp/assets" \
    "$runner" "$@"
}

: > "$tmp/docker.log"
dry_output=$(run_runner)
grep -Fq '"applied":false' <<< "$dry_output"
grep -Fq 'create --network bridge --env-file ' "$tmp/docker.log"
grep -Fq -- '--env TMPDIR=/tmp' "$tmp/docker.log"
grep -Fq -- '--import /app/apps/worker/node_modules/tsx/dist/loader.mjs' "$tmp/docker.log"
grep -Fq -- '--input-type=module --eval await import(process.argv[1])' "$tmp/docker.log"
grep -Fq "cp $tmp/assets/backfill-clear-wrong-trial-claims.ts trial-backfill-container:/app/apps/worker/node_modules/@lyrashield/db/scripts/backfill-clear-wrong-trial-claims.ts" "$tmp/docker.log"
grep -Fq 'start --attach trial-backfill-container' "$tmp/docker.log"
grep -Fq 'rm --force trial-backfill-container' "$tmp/docker.log"

: > "$tmp/docker.log"
apply_output=$(run_runner --apply=backfill-clear-wrong-trial-claims)
grep -Fq '"applied":false' <<< "$apply_output"
grep -Fq -- '--apply=backfill-clear-wrong-trial-claims' "$tmp/docker.log"

: > "$tmp/docker.log"
set +e
invalid_output=$(run_runner --apply 2>&1)
invalid_status=$?
set -e
[ "$invalid_status" -ne 0 ]
grep -Fq 'Usage: lyrashield-trial-claim-backfill' <<< "$invalid_output"
[ ! -s "$tmp/docker.log" ]

echo "Trial-claim VM backfill runner proof passed."
