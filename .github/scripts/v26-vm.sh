#!/bin/sh
# Controller transport; caller transfers the four v26 modules alongside this file.
set -eu
phase=${1:?phase}
request=${2:?encoded identity}
extra=${3:-}
directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config=${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}
environment_file=${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}
state=${LYRASHIELD_V26_STATE_DIR:-/var/lib/lyrashield}
# The transport copies the reviewed worker-env.sh alongside this script.
# shellcheck disable=SC1091
. "$directory/worker-env.sh"
image=$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' "$config")
case "$image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) exit 1;; esac
[ -d "$state" ] && [ ! -L "$state" ] && [ "$(stat -c %u "$state")" = 0 ] || exit 1
# flock releases automatically on a killed process, unlike stale PID lock files.
exec 9>"$state/v26-cutover.lock"
flock -n 9 || { echo 'v26 operation already running' >&2; exit 1; }
env_args=$(lyrashield_worker_env_args "$config" "$environment_file")
# Match the live worker and existing promotion probes against the committed
# firewall allowlist; independent DNS resolution is not authoritative here.
worker_pinned_host_args() {
  pins=${LYRASHIELD_EGRESS_PIN_FILE:-/run/lyrashield-egress-hosts}
  [ -r "$pins" ] && [ -s "$pins" ] || { echo 'Worker egress pins are unavailable' >&2; return 1; }
  while read -r pinned_host pinned_address pinned_port extra_pin || [ -n "$pinned_host" ]; do
    case "$pinned_host" in ''|*[!A-Za-z0-9.-]*) echo 'Invalid host in worker egress pins' >&2; return 1;; esac
    case "$pinned_address" in ''|*[!0-9.]*) echo 'Invalid IPv4 address in worker egress pins' >&2; return 1;; esac
    case "$pinned_port" in ''|*[!0-9]*) echo 'Invalid port in worker egress pins' >&2; return 1;; esac
    [ -z "$extra_pin" ] && [ "$pinned_port" -ge 1 ] && [ "$pinned_port" -le 65535 ] || { echo 'Invalid worker egress pin entry' >&2; return 1; }
    printf '%s\n' "--add-host ${pinned_host}:${pinned_address}"
  done < "$pins"
}
pin_args=$(worker_pinned_host_args)
oneshot() {
  # /run is volatile. Only the stopped-worker proof consumes this directory;
  # initial observation must work before ExecStop has ever created it.
  stop_mount=
  if [ "$1" = quiesced ]; then
    stop_mount='--mount type=bind,src=/run/lyrashield,dst=/v26-stop,readonly'
  fi
  # Only maintenance metadata is writable. No Docker socket, scan tree or
  # provider output is mounted. Root is needed for the root-owned receipt.
  # shellcheck disable=SC2086
  timeout --kill-after=10s 120s docker run --rm --user 0 --network bridge \
    --env-file "$environment_file" $pin_args $env_args --env TMPDIR=/tmp \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --mount "type=bind,src=$directory,dst=/v26,readonly" \
    --mount "type=bind,src=$state,dst=/v26-state" \
    $stop_mount \
    -w /app/apps/worker "$image" node --import tsx /v26/v26-vm-state.mjs "$@"
}
assert_stopped() {
  for unit in lyrashield-worker.service lyrashield-worker-egress-refresh.timer; do
    status=$(systemctl is-active "$unit" || true)
    case "$status" in inactive|failed) ;; *) exit 1;; esac
    [ "$(systemctl is-enabled "$unit" || true)" = disabled ] || exit 1
  done
  [ "$(systemctl is-active lyrashield-worker-egress-refresh.service || true)" = inactive ] || exit 1
  [ -z "$(timeout 10s docker ps -a --filter 'name=^/lyrashield-worker$' --format '{{.Names}}' 2>/dev/null)" ] || exit 1
  sh "$directory/v26-execution-drain.sh"
}
case "$phase" in
probe)
  if systemctl is-active --quiet lyrashield-worker.service; then
    [ "$(docker inspect --format '{{.Config.Image}}' lyrashield-worker)" = "$image" ] || exit 1
    # Actual live environment hashes close the stale worker.env/KV gap.
    live=$(docker exec lyrashield-worker node --input-type=module -e 'import {createHash} from "node:crypto"; const hash=v=>createHash("sha256").update(v??"").digest("hex"); console.log(JSON.stringify({databaseUrlSha256:hash(process.env.DATABASE_URL),databaseSystemUrlSha256:hash(process.env.DATABASE_SYSTEM_URL),redisUrlSha256:hash(process.env.REDIS_URL)}));' 2>/dev/null)
    result=$(oneshot probe "$request" "$extra")
    # Validate privately in a credential-free node in the same image.
    private=$(printf '%s\n' "$result" | sed -n 's/^V26_PRIVATE=//p')
    docker run --rm --network none --entrypoint node "$image" -e 'const [a,b]=process.argv.slice(1);const actual=JSON.parse(a),observed=JSON.parse(Buffer.from(b,"base64").toString()).worker;if(Object.entries(actual).some(([k,v])=>observed[k]!==v))process.exit(1)' "$live" "$private" >/dev/null 2>&1
    printf '%s\n' "$result"
  else
    oneshot probe "$request" "$extra"
  fi
  printf 'V26_WORKER_IMAGE=%s\n' "$image"
  ;;
stop)
  oneshot owned "$request" "$extra"
  # Existing work must finish before systemd is allowed to stop the consumer.
  oneshot queues "$request" "$extra"
  systemctl disable --now lyrashield-worker-egress-refresh.timer
  systemctl stop lyrashield-worker-egress-refresh.service
  systemctl disable --now lyrashield-worker.service
  assert_stopped
  receipt=/run/lyrashield/worker-stop-provenance.json
  [ ! -L "$receipt" ] && [ "$(stat -c '%u:%a' "$receipt")" = 0:600 ] || exit 1
  oneshot quiesced "$request" "$extra"
  ;;
quiesced|inventory|migration-intent|migrated)
  assert_stopped
  oneshot "$phase" "$request" "$extra"
  ;;
verify|release)
  systemctl is-active --quiet lyrashield-worker.service
  [ "$(docker inspect --format '{{.State.Health.Status}}' lyrashield-worker)" = healthy ] || exit 1
  [ "$(docker inspect --format '{{.Config.Image}}' lyrashield-worker)" = "$image" ] || exit 1
  if [ "$phase" = verify ]; then oneshot owned "$request" "$extra"; fi
  if [ "$phase" = release ]; then
    systemctl enable --now lyrashield-worker-egress-refresh.timer
    systemctl is-active --quiet lyrashield-worker-egress-refresh.timer
  fi
  oneshot "$phase" "$request" "$extra"
  ;;
claim|owned|queues) oneshot "$phase" "$request" "$extra";;
*) exit 1;;
esac
