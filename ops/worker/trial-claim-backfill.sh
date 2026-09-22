#!/bin/sh
set -eu

confirmation="backfill-clear-wrong-trial-claims"
runtime_config="${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}"
environment_file="${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}"
worker_env_lib="${LYRASHIELD_WORKER_ENV_LIB:-/opt/lyrashield-worker-host/worker-env.sh}"
host_assets_dir="${LYRASHIELD_WORKER_HOST_ASSETS_DIR:-/opt/lyrashield-worker-host}"
backfill_source="$host_assets_dir/backfill-clear-wrong-trial-claims.ts"
inside_source="/app/apps/worker/node_modules/@lyrashield/db/scripts/backfill-clear-wrong-trial-claims.ts"
# The production image installs `tsx` under the worker package, not `/app`.
# Keep this absolute path tied to the image layout so the maintenance runner
# never depends on an undeclared global loader.
tsx_loader="/app/apps/worker/node_modules/tsx/dist/loader.mjs"

usage() {
  echo "Usage: lyrashield-trial-claim-backfill [--apply=$confirmation]" >&2
  exit 64
}

case "${1:-}" in
  "") [ "$#" -eq 0 ] || usage ;;
  "--apply=$confirmation") [ "$#" -eq 1 ] || usage ;;
  *) usage ;;
esac

for path in "$runtime_config" "$environment_file" "$worker_env_lib" "$host_assets_dir" "$backfill_source"; do
  case "$path" in
    /*) ;;
    *) echo "Trial-claim backfill paths must be absolute" >&2; exit 1 ;;
  esac
done
[ -r "$runtime_config" ] || { echo "Worker runtime configuration is unavailable" >&2; exit 1; }
[ -r "$environment_file" ] || { echo "Worker environment file is unavailable" >&2; exit 1; }
[ -r "$worker_env_lib" ] || { echo "Worker environment library is unavailable" >&2; exit 1; }
[ -f "$backfill_source" ] && [ ! -L "$backfill_source" ] || {
  echo "Trial-claim backfill source is unavailable or unsafe" >&2
  exit 1
}

# shellcheck disable=SC1090
. "$worker_env_lib"
set -a
# shellcheck disable=SC1090
. "$runtime_config"
set +a

: "${LYRASHIELD_WORKER_IMAGE:?Set an immutable worker image in the runtime configuration}"
case "$LYRASHIELD_WORKER_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "Worker image must be pinned by sha256 digest" >&2; exit 1 ;;
esac

# The one-shot needs only the privileged DB URL, never the worker's other
# credentials. Keep it in a private temporary env-file rather than a command
# argument so it cannot appear in process listings or command history.
database_system_url=$(sed -n 's/^DATABASE_SYSTEM_URL=//p' "$environment_file" | head -n 1)
case "$database_system_url" in
  ""|*[[:space:]]*)
    echo "DATABASE_SYSTEM_URL is unavailable or unsafe" >&2
    exit 1
    ;;
esac

old_umask=$(umask)
umask 077
maintenance_env=$(mktemp "${TMPDIR:-/tmp}/lyrashield-trial-claim.XXXXXX")
umask "$old_umask"
container=
cleanup() {
  if [ -n "$container" ]; then
    docker rm --force "$container" >/dev/null 2>&1 || true
  fi
  rm -f "$maintenance_env"
}
trap cleanup EXIT HUP INT TERM
printf 'NODE_ENV=production\nDATABASE_SYSTEM_URL=%s\n' "$database_system_url" > "$maintenance_env"
unset database_system_url

# worker-env.sh derives immutable provenance and uses the current image labels.
# It adds no credentials; the private env file above is the complete secret set.
env_args=$(lyrashield_worker_env_args "$runtime_config" "$environment_file")

# Intentional word splitting: worker-env.sh emits one --env argument pair per
# line and every emitted value is whitespace-free.
# shellcheck disable=SC2086
container=$(docker create \
  --network bridge \
  --env-file "$maintenance_env" \
  $env_args \
  --env TMPDIR=/tmp \
  --entrypoint node \
  "$LYRASHIELD_WORKER_IMAGE" \
  --import "$tsx_loader" \
  "$inside_source" \
  "$@")
docker cp "$backfill_source" "$container:$inside_source"
docker start --attach "$container"
