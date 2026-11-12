#!/bin/sh
set -eu

config=${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}
environment_file=${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}
assets=${LYRASHIELD_WORKER_HOST_ASSETS_DIR:-/opt/lyrashield-worker-host}
state=/var/lib/lyrashield/worker-cold-start
[ "${LYRASHIELD_WORKER_COLD_START_DIR:-$state}" = "$state" ] || exit 1
[ -r "$config" ] && [ -r "$environment_file" ] || exit 1
[ ! -L "$config" ] && [ "$(stat -c '%u:%a' "$config")" = 0:600 ] || exit 1
unset LYRASHIELD_COLD_SINGLE_WORKER LYRASHIELD_COLD_DATABASE_EPOCH_SHA256 LYRASHIELD_WORKER_IMAGE LYRASHIELD_SANDBOX_IMAGE
# These are the original root-owned runtime controls; never refresh the epoch pin.
# shellcheck disable=SC1090
. "$config"
[ "${LYRASHIELD_COLD_SINGLE_WORKER:-}" = 1 ] || exit 1
case "${LYRASHIELD_COLD_DATABASE_EPOCH_SHA256:-}" in ''|*[!a-f0-9]*) exit 1 ;; esac
[ "${#LYRASHIELD_COLD_DATABASE_EPOCH_SHA256}" -eq 64 ] || exit 1
install -d -m 700 "$state"
[ ! -L "$state" ] && [ "$(stat -c '%u:%a' "$state")" = 0:700 ] || exit 1
exec 8>"$state/recovery.lock"
flock -n 8 || exit 1
# shellcheck disable=SC1090
. "$assets/worker-env.sh"
env_args=$(lyrashield_worker_env_args "$config" "$environment_file")
pins=${LYRASHIELD_EGRESS_PIN_FILE:-/run/lyrashield-egress-hosts}
[ -s "$pins" ] || exit 1
recovery_pinned_host_args() {
  while read -r host address port extra; do
    case "$host" in ''|*[!A-Za-z0-9.-]*) exit 1 ;; esac
    case "$address" in ''|*[!0-9.]*) exit 1 ;; esac
    case "$port" in ''|*[!0-9]*) exit 1 ;; esac
    [ -z "$extra" ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || exit 1
    printf '%s\n' "--add-host $host:$address"
  done < "$pins"
}
pin_args=$(recovery_pinned_host_args)
stop_file="$state/recovery-stop.json"
if [ ! -s "$stop_file" ]; then
  owner=$(cat /proc/sys/kernel/random/uuid)
  (umask 077; set -C; printf '{"operator":"worker-recovery","reason":"native-cold-restart","owner":"%s"}' "$owner" > "$stop_file")
  sync -f "$state"
fi
[ ! -L "$stop_file" ] && [ "$(stat -c '%u:%a' "$stop_file")" = 0:600 ] || exit 1
stop_value=$(cat "$stop_file")

probe() (
  phase=$1
  probe_dir=$(mktemp -d)
  cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ -s "$probe_dir/container.id" ]; then
      id=$(cat "$probe_dir/container.id")
      case "$id" in ''|*[!a-f0-9]*) status=1 ;; *)
        [ "${#id}" -eq 64 ] && timeout 15s docker rm -f "$id" >/dev/null 2>&1 || status=1 ;;
      esac
    fi
    rm -rf "$probe_dir"
    exit "$status"
  }
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  # Only this invocation's probe ID may be removed. The socket/shared root are never mounted.
  # shellcheck disable=SC2086
  timeout --kill-after=5s 60s docker run --name "lyrashield-worker-recovery-$(basename "$probe_dir")" \
    --cidfile "$probe_dir/container.id" --network bridge --no-healthcheck \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m --env-file "$environment_file" $pin_args $env_args \
    --env LYRASHIELD_COLD_SINGLE_WORKER=1 \
    --env LYRASHIELD_COLD_DATABASE_EPOCH_SHA256="$LYRASHIELD_COLD_DATABASE_EPOCH_SHA256" \
    --env TMPDIR=/tmp -w /app/apps/worker "$LYRASHIELD_WORKER_IMAGE" \
    node --import tsx /opt/lyrashield-worker-host/worker-recovery-probe.mjs "$phase" "$stop_value"
)
starting=0
failed() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ]; then
    # Re-establish only our stop after a lost release/start acknowledgement.
    probe claim >/dev/null 2>&1 || true
    if [ "$starting" -eq 1 ]; then systemctl stop lyrashield-worker.service >/dev/null 2>&1 || true; fi
    echo "Automatic worker recovery remains held; original database epoch retained" >&2
  fi
  exit "$status"
}
trap failed EXIT
trap 'exit 1' HUP INT TERM
systemctl start docker.service
probe claim >/dev/null
/usr/bin/python3 "$assets/cold-start-barrier.py" \
  --worker-image "$LYRASHIELD_WORKER_IMAGE" --sandbox-image "$LYRASHIELD_SANDBOX_IMAGE" \
  --network "${LYRASHIELD_SANDBOX_NETWORK:-lyrashield-sandbox}" --confirm COLD_SINGLE_WORKER >/dev/null
# Recheck after the physical barrier; no pin is ever replaced during recovery.
probe release >/dev/null
systemctl reset-failed lyrashield-worker.service
starting=1
systemctl start lyrashield-worker.service
ready=0
for attempt in $(seq 1 30); do
  if [ "$(docker inspect lyrashield-worker --format '{{.State.Health.Status}}' 2>/dev/null || true)" = healthy ]; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || exit 1
rm "$stop_file"
sync -f "$state"
