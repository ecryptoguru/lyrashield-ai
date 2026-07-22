#!/bin/sh
set -eu

runtime_config="${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}"
environment_file="${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}"

if [ ! -r "$runtime_config" ]; then
  echo "Worker runtime configuration is unavailable: $runtime_config" >&2
  exit 1
fi
if [ ! -r "$environment_file" ]; then
  echo "Worker environment file is unavailable: $environment_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$runtime_config"
set +a

: "${LYRASHIELD_WORKER_IMAGE:?Set an immutable worker image in the runtime configuration}"
: "${LYRASHIELD_SANDBOX_IMAGE:?Set an immutable sandbox image in the runtime configuration}"
: "${LYRASHIELD_SANDBOX_NETWORK:=lyrashield-sandbox}"

case "$LYRASHIELD_WORKER_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo "Worker image must be pinned by sha256 digest" >&2
    exit 1
    ;;
esac
case "$LYRASHIELD_SANDBOX_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo "Sandbox image must be pinned by sha256 digest" >&2
    exit 1
    ;;
esac

acr_name=${LYRASHIELD_WORKER_IMAGE%%.*}
if ! command -v az >/dev/null 2>&1; then
  echo "Azure CLI is required to authenticate the worker image pull" >&2
  exit 1
fi
if ! az login --identity --allow-no-subscriptions >/dev/null 2>&1 || ! az acr login --name "$acr_name" >/dev/null 2>&1; then
  echo "Unable to authenticate the worker image pull through the VM managed identity" >&2
  exit 1
fi

socket_group=$(stat -c '%g' /var/run/docker.sock)
pin_file="${LYRASHIELD_EGRESS_PIN_FILE:-/run/lyrashield-egress-hosts}"
if [ ! -s "$pin_file" ]; then
  echo "Worker egress pins are unavailable: $pin_file" >&2
  exit 1
fi

set --
while read -r pinned_host pinned_address pinned_port extra; do
  case "$pinned_host" in
    '' | *[!A-Za-z0-9.-]*)
      echo "Invalid host in worker egress pins" >&2
      exit 1
      ;;
  esac
  case "$pinned_address" in
    '' | *[!0-9.]*)
      echo "Invalid IPv4 address in worker egress pins" >&2
      exit 1
      ;;
  esac
  if [ -z "$pinned_port" ] || [ -n "${extra:-}" ]; then
    echo "Invalid worker egress pin entry" >&2
    exit 1
  fi
  set -- "$@" --add-host "${pinned_host}:${pinned_address}"
done <"$pin_file"

docker rm -f lyrashield-worker >/dev/null 2>&1 || true
docker volume create lyrashield-worker-runs >/dev/null
docker run --rm \
  --network none \
  --user 0:0 \
  --mount type=volume,src=lyrashield-worker-runs,dst=/work \
  --entrypoint sh \
  "$LYRASHIELD_WORKER_IMAGE" \
  -c 'chown -R lyrashield:lyrashield /work && chmod 700 /work'

docker create \
  --name lyrashield-worker \
  --network bridge \
  "$@" \
  --env-file "$environment_file" \
  --env NODE_ENV=production \
  --env LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0 \
  --env LYRASHIELD_WORKER_CONCURRENCY=1 \
  --env PLATFORM_MAX_SCAN_BUDGET_USD=50 \
  --env LYRASHIELD_RUNTIME_BACKEND=docker \
  --env LYRASHIELD_ENGINE_PATH=/opt/lyrashield-venv/bin/lyrashield \
  --env LYRASHIELD_ENGINE_SANDBOX_NETWORK="$LYRASHIELD_SANDBOX_NETWORK" \
  --env LYRASHIELD_IMAGE="$LYRASHIELD_SANDBOX_IMAGE" \
  --env LYRASHIELD_TELEMETRY=0 \
  --env LYRASHIELD_LOCAL_EVIDENCE_STORAGE=0 \
  --group-add "$socket_group" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=volume,src=lyrashield-worker-runs,dst=/app/apps/worker/lyrashield_runs \
  --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  --security-opt no-new-privileges=true \
  --cap-drop ALL \
  --memory 3g \
  --pids-limit 768 \
  --stop-timeout 35 \
  --health-cmd='test -f /tmp/lyrashield-worker-ready' \
  --health-interval=15s \
  --health-timeout=5s \
  --health-retries=3 \
  --log-driver=json-file \
  --log-opt=max-size=20m \
  --log-opt=max-file=5 \
  "$LYRASHIELD_WORKER_IMAGE" >/dev/null

docker network connect "$LYRASHIELD_SANDBOX_NETWORK" lyrashield-worker
exec docker start --attach lyrashield-worker
