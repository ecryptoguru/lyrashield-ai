#!/bin/sh
set -eu

config=${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}
environment_file=${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}
host_assets_dir=${LYRASHIELD_WORKER_HOST_ASSETS_DIR:-/opt/lyrashield-worker-host}
container=lyrashield-worker

# The one-shot preflight and Redis evals must see the same environment the
# live worker gets. Prefer the host copy installed by an earlier promotion;
# until the first promotion ships it, the workflow embeds the library in the
# run-command payload.
if [ -r "$host_assets_dir/worker-env.sh" ]; then
  worker_env_lib="$host_assets_dir/worker-env.sh"
elif [ -n "${LYRASHIELD_WORKER_ENV_LIB:-}" ] && [ -r "$LYRASHIELD_WORKER_ENV_LIB" ]; then
  worker_env_lib=$LYRASHIELD_WORKER_ENV_LIB
else
  echo "worker-env.sh is required for worker environment parity" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$worker_env_lib"

worker_image_from_config() {
  image=$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' "$config" | head -n 1)
  case "$image" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *)
      echo "Worker image must be pinned by sha256 digest" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$image"
}

# Runs a one-shot worker-image container with the full worker environment: the
# environment file plus the same --env set the live worker gets. The docker
# socket and the shared root stay unmounted; the container only reaches
# Postgres and Redis.
worker_oneshot() {
  code=$1
  shift
  image=$(worker_image_from_config)
  env_args=$(lyrashield_worker_env_args "$config" "$environment_file")
  # Intentional word splitting: worker-env.sh emits one `--env` argument pair
  # per line and every emitted value is whitespace-free.
  # shellcheck disable=SC2086
  docker run --rm --network bridge \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --env-file "$environment_file" \
    $env_args \
    --env TMPDIR=/tmp \
    -w /app/apps/worker "$image" \
    node --import tsx --input-type=module -e "$code" "$@"
}

queue_count='const {getSystemPrisma}=await import("@lyrashield/db"); const {getScanQueue,getWebhookTrackRetryQueue,closeRedis}=await import("@lyrashield/integrations"); const prisma=getSystemPrisma(); const scanQueue=getScanQueue(); const webhookQueue=getWebhookTrackRetryQueue(); try { const [nonterminal,scan,webhook]=await Promise.all([prisma.scan.count({where:{status:{in:["QUEUED","PREFLIGHT","RUNNING","VERIFYING","REQUIRES_APPROVAL"]}}}),scanQueue.getJobCounts("wait","active","delayed","prioritized"),webhookQueue.getJobCounts("wait","active","delayed","prioritized")]); console.log(JSON.stringify({nonterminal,scan,webhook})); } finally { await Promise.allSettled([prisma.$disconnect(),scanQueue.close(),webhookQueue.close(),closeRedis()]); }'
queue_expected='{"nonterminal":0,"scan":{"wait":0,"active":0,"delayed":0,"prioritized":0},"webhook":{"wait":0,"active":0,"delayed":0,"prioritized":0}}'

assert_empty_queues() {
  if ! preflight=$(worker_oneshot "$queue_count"); then
    echo "Worker promotion requires empty scan and webhook queues" >&2
    exit 1
  fi
  [ "$preflight" = "$queue_expected" ] || {
    echo "Worker promotion requires empty scan and webhook queues" >&2
    exit 1
  }
}

# Host[:port] of a URL with the scheme, credentials and path stripped. Values
# are only ever compared; the comparison result is all that is reported.
env_url_host_port() {
  rest=${1#*://}
  rest=${rest%%/*}
  printf '%s\n' "${rest##*@}"
}

# The live worker reads its environment once at service start. A rotated
# secret lands in the refreshed environment file immediately but the running
# container keeps the old endpoint, so compare both before trusting a healthy
# heartbeat. Never print either endpoint.
worker_environment_is_fresh() {
  live_redis=$(docker exec "$container" printenv REDIS_URL 2>/dev/null || true)
  file_redis=$(sed -n 's/^REDIS_URL=//p' "$environment_file" | head -n 1)
  live_database=$(docker exec "$container" printenv DATABASE_URL 2>/dev/null || true)
  file_database=$(sed -n 's/^DATABASE_URL=//p' "$environment_file" | head -n 1)
  [ "$(env_url_host_port "$live_redis")" = "$(env_url_host_port "$file_redis")" ] &&
    [ "$(env_url_host_port "$live_database")" = "$(env_url_host_port "$file_database")" ]
}

assert_worker_environment_fresh() {
  if ! worker_environment_is_fresh; then
    echo "Worker environment is stale: restart lyrashield-worker.service before promotion" >&2
    exit 1
  fi
}

assert_empty_queues_with_refreshed_environment() {
  # Refresh the one-shot preflight environment without touching the active worker.
  systemctl restart lyrashield-worker-secrets.service
  if ! preflight=$(worker_oneshot "$queue_count"); then
    echo "Worker promotion requires empty scan and webhook queues" >&2
    exit 1
  fi
  [ "$preflight" = "$queue_expected" ] || {
    echo "Worker promotion requires empty scan and webhook queues" >&2
    exit 1
  }
  if ! worker_environment_is_fresh; then
    echo "Worker environment is stale; continuing with the refreshed one-shot preflight"
  fi
}
if [ "${1:-}" = "--preflight" ]; then
  assert_empty_queues_with_refreshed_environment
  echo "Worker empty-queue preflight passed"
  exit 0
fi

target=${1:?worker image digest reference is required}
expected_app=${2:?product revision is required}
expected_engine=${3:?engine revision is required}
timer=lyrashield-worker-egress-refresh.timer
service=lyrashield-worker.service
promotion_state_dir=${LYRASHIELD_WORKER_PROMOTION_STATE_DIR:-/var/lib/lyrashield}
host_libexec_dir=${LYRASHIELD_WORKER_HOST_LIBEXEC_DIR:-/usr/local/libexec}
systemd_dir=${LYRASHIELD_WORKER_SYSTEMD_DIR:-/etc/systemd/system}

for directory in "$promotion_state_dir" "$host_libexec_dir" "$systemd_dir" "$host_assets_dir"; do
  case "$directory" in
    /*) ;;
    *) echo "Worker promotion paths must be absolute" >&2; exit 1 ;;
  esac
done

case "$target" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "Worker image must be pinned by sha256 digest" >&2; exit 1 ;;
esac
digest=${target##*@sha256:}
case "$digest" in
  ''|*[!0-9a-fA-F]*) echo "Worker image digest must contain 64 hexadecimal characters" >&2; exit 1 ;;
esac
is_40_hex() {
  value=$1
  case "$value" in
    ''|*[!0-9a-fA-F]*) return 1 ;;
  esac
  [ "${#value}" -eq 40 ]
}
if ! is_40_hex "$expected_app" || ! is_40_hex "$expected_engine"; then
  echo "Product and engine revisions must be exact 40-character SHAs" >&2
  exit 1
fi

old_image=$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' "$config")
[ -n "$old_image" ]
backup="${config}.rollback-${expected_app}"
timer_was_active=0
systemctl is-active --quiet "$timer" && timer_was_active=1
admission_stop_owned=0
admission_stop_value=
config_changed=0
host_assets_changed=0
promotion_complete=0
promotion_step=initializing
asset_container=
asset_stage=
host_backup=

# Redis evals run in a one-shot container built from the refreshed environment
# file, so the admission stop and the queue counts are evaluated against the
# rotated endpoint rather than the stale environment inside the live worker.
redis_eval() {
  worker_oneshot "$@"
}

resume_admission() {
  # JavaScript template literal is passed verbatim to the container.
  # shellcheck disable=SC2016
  removed=$(redis_eval 'const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:null}); const removed=await redis.eval(`if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`,1,"lyrashield:scan-admission:stopped",process.argv[1]); console.log(removed); await redis.quit();' "$admission_stop_value")
  case "$removed" in
    0) echo "Newer scan admission stop preserved" ;;
    1) ;;
    *) echo "Worker promotion could not safely resume scan admission" >&2; return 1 ;;
  esac
  admission_stop_owned=0
  admission_stop_value=
}

worker_is_healthy() {
  health=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)
  [ "$health" = healthy ]
}

wait_healthy() {
  for _ in $(seq 1 600); do
    worker_is_healthy && return 0
    sleep 1
  done
  return 1
}

restore_timer() {
  [ "$timer_was_active" -eq 0 ] || systemctl start "$timer"
}

restore_host_assets() {
  restore_failed=0
  install -m 0755 "$host_backup/run-worker.sh" "$host_libexec_dir/lyrashield-run-worker" || restore_failed=1
  install -m 0755 "$host_backup/refresh-secrets.sh" "$host_libexec_dir/lyrashield-refresh-secrets" || restore_failed=1
  install -m 0755 "$host_backup/refresh-egress.sh" "$host_libexec_dir/lyrashield-refresh-egress" || restore_failed=1
  install -m 0755 "$host_backup/capture-stop-provenance.sh" "$host_libexec_dir/lyrashield-capture-worker-stop-provenance" || restore_failed=1
  # worker-env.sh is absent from backups taken before it shipped; remove the
  # installed copy in that case so the old run-worker.sh never sees a partial
  # library pair.
  if [ -f "$host_backup/worker-env.sh" ]; then
    install -m 0644 "$host_backup/worker-env.sh" "$host_assets_dir/worker-env.sh" || restore_failed=1
  else
    rm -f "$host_assets_dir/worker-env.sh" || restore_failed=1
  fi
  install -m 0644 "$host_backup/lyrashield-worker.service" "$systemd_dir/lyrashield-worker.service" || restore_failed=1
  install -m 0644 "$host_backup/lyrashield-worker-secrets.service" "$systemd_dir/lyrashield-worker-secrets.service" || restore_failed=1
  install -m 0644 "$host_backup/lyrashield-worker-egress.service" "$systemd_dir/lyrashield-worker-egress.service" || restore_failed=1
  install -m 0644 "$host_backup/lyrashield-worker-egress-refresh.service" "$systemd_dir/lyrashield-worker-egress-refresh.service" || restore_failed=1
  install -m 0644 "$host_backup/lyrashield-worker-egress-refresh.timer" "$systemd_dir/lyrashield-worker-egress-refresh.timer" || restore_failed=1
  systemctl daemon-reload || restore_failed=1
  [ "$restore_failed" -eq 0 ] || return 1
  host_assets_changed=0
}

cleanup_host_assets() {
  if [ -n "$asset_container" ]; then
    docker rm --force "$asset_container" >/dev/null 2>&1 || true
  fi
  if [ -n "$asset_stage" ]; then
    rm -rf "$asset_stage"
  fi
  if [ -n "$host_backup" ]; then
    rm -rf "$host_backup"
  fi
}

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$promotion_complete" -ne 1 ]; then
    if [ "$host_assets_changed" -eq 1 ]; then
      restore_host_assets || echo "Worker host asset rollback failed" >&2
    fi
    if [ "$config_changed" -eq 1 ]; then
      cp -p "$backup" "$config"
      systemctl reset-failed "$service" || true
      systemctl restart "$service" || true
      if wait_healthy && [ "$admission_stop_owned" -eq 1 ]; then
        resume_admission || true
      fi
    elif [ "$admission_stop_owned" -eq 1 ]; then
      resume_admission || true
    fi
    restore_timer || true
    echo "Worker promotion failed during: ${promotion_step} (exit ${status}); prior digest restored" >&2
  fi
  cleanup_host_assets
  exit "$status"
}
trap rollback EXIT HUP INT TERM

# Keep DNS refresh from racing the bounded replacement window. The timer is
# restored after success or rollback.
promotion_step=quiescing-egress-refresh
systemctl stop "$timer"
for _ in $(seq 1 60); do
  systemctl is-active --quiet lyrashield-worker-egress-refresh.service || break
  sleep 1
done
systemctl is-active --quiet lyrashield-worker-egress-refresh.service && {
  echo "Egress refresh did not quiesce" >&2
  exit 1
}
promotion_step=checking-current-worker
if ! worker_is_healthy; then
  if worker_environment_is_fresh; then
    echo "Current worker is unhealthy with a fresh environment" >&2
    exit 1
  fi
  echo "Current worker is unhealthy with a stale environment; continuing with refreshed one-shot checks" >&2
fi

# Refresh the Key Vault environment file before the admission claim and the
# queue check so both evaluate the rotated endpoints. The live worker is not
# restarted here: it keeps draining its old environment while the admission
# stop and the empty-queue proof run against the new endpoint through
# one-shot containers. The single restart later in this script is what cuts
# the worker over.
systemctl restart lyrashield-worker-secrets.service

# JavaScript template literal is passed verbatim to the container.
# shellcheck disable=SC2016
promotion_step=claiming-admission-stop
admission_stop_claim=$(redis_eval 'const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:null}); const key="lyrashield:scan-admission:stopped"; const value=JSON.stringify({operator:"github-actions",reason:"worker-promotion",at:new Date().toISOString()}); const claimed=await redis.eval(`if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end redis.call("SET", KEYS[1], ARGV[1]) return 1`,1,key,value); console.log(claimed); if (claimed === 1) console.log(value); await redis.quit();')
admission_stop_owned=$(printf '%s\n' "$admission_stop_claim" | sed -n '1p')
admission_stop_value=$(printf '%s\n' "$admission_stop_claim" | sed -n '2p')
case "$admission_stop_owned" in
  0) echo "Existing scan admission stop preserved" ;;
  1) [ -n "$admission_stop_value" ] || { echo "Worker promotion admission receipt is missing" >&2; exit 1; } ;;
  *) echo "Worker promotion could not establish scan admission ownership" >&2; exit 1 ;;
esac

promotion_step=checking-queues
assert_empty_queues

# Keep the running worker image for rollback while reclaiming superseded release
# images before Docker needs space for both compressed and extracted target layers.
promotion_step=cleaning-images
docker_root=$(docker info --format '{{.DockerRootDir}}')
if current_image_id=$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null); then
  current_image_size=$(docker image inspect "$current_image_id" --format '{{.Size}}')
  prune_all=1
else
  # A failed service restart can remove the container. Size and preserve the
  # configured rollback image while bootstrapping its replacement. When that
  # image is absent locally too, there is nothing to measure — fall back to
  # the image-size floor so the disk check still carries a real budget
  # (required_free = 3 x floor + 2 GiB; 26 GiB at the 8 GiB default). The
  # floor is a policy value, not a measurement: override it through
  # LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES to match the production VM disk.
  if ! current_image_size=$(docker image inspect "$old_image" --format '{{.Size}}' 2>/dev/null); then
    if [ -n "${LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES:-}" ]; then
      case "$LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES" in
        ''|*[!0-9]*|0) echo "LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES must be a positive integer" >&2; exit 1 ;;
      esac
    fi
    image_floor_bytes=${LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES:-8589934592}
    echo "No local rollback image found; sizing the disk preflight from the ${image_floor_bytes}-byte floor" >&2
    current_image_size=$image_floor_bytes
  fi
  prune_all=0
fi
required_free=$((current_image_size * 3 + 2147483648))
free_before=$(df -P -B1 "$docker_root" | awk 'NR == 2 { print $4 }')
if [ "$prune_all" -eq 1 ]; then
  docker image prune --all --force >/dev/null
else
  docker image prune --force >/dev/null
fi
free_after=$(df -P -B1 "$docker_root" | awk 'NR == 2 { print $4 }')
reclaimed=$((free_after - free_before))
echo "Worker image cleanup reclaimed ${reclaimed} bytes; ${free_after} bytes available"
[ "$free_after" -ge "$required_free" ] || {
  echo "Worker image pull requires ${required_free} free bytes; found ${free_after}" >&2
  exit 1
}

promotion_step=pulling-worker-image
ghcr_username=$(sed -n 's/^GHCR_USERNAME=//p' "$config" | head -n 1)
ghcr_token=$(sed -n 's/^GHCR_TOKEN=//p' "$environment_file" | head -n 1)
[ -n "$ghcr_username" ]
[ -n "$ghcr_token" ]
printf '%s\n' "$ghcr_token" | docker login ghcr.io -u "$ghcr_username" --password-stdin >/dev/null 2>&1
docker pull "$target" >/dev/null
promotion_step=checking-image-provenance
app_label=$(docker image inspect "$target" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
engine_label=$(docker image inspect "$target" --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}')
[ "$app_label" = "$expected_app" ]
[ "$engine_label" = "$expected_engine" ]

# Host scripts and units are release assets bound to the same reviewed image
# digest as the worker. Installing them here prevents VM bootstrap drift from
# silently omitting new fail-closed configuration before the service restart.
promotion_step=installing-host-assets
asset_stage=$(mktemp -d "$promotion_state_dir/worker-host-assets.XXXXXX")
asset_container=$(docker create "$target")
docker cp "$asset_container:/opt/lyrashield-worker-host/." "$asset_stage"
docker rm "$asset_container" >/dev/null
asset_container=
for asset in \
  run-worker.sh \
  worker-env.sh \
  refresh-secrets.sh \
  refresh-egress.sh \
  capture-stop-provenance.sh \
  lyrashield-worker.service \
  lyrashield-worker-secrets.service \
  lyrashield-worker-egress.service \
  lyrashield-worker-egress-refresh.service \
  lyrashield-worker-egress-refresh.timer
do
  if [ ! -f "$asset_stage/$asset" ] || [ -L "$asset_stage/$asset" ]; then
    echo "Worker image is missing host asset: $asset" >&2
    exit 1
  fi
done

host_backup=$(mktemp -d "$promotion_state_dir/worker-host-backup.XXXXXX")
cp -p "$host_libexec_dir/lyrashield-run-worker" "$host_backup/run-worker.sh"
cp -p "$host_libexec_dir/lyrashield-refresh-secrets" "$host_backup/refresh-secrets.sh"
cp -p "$host_libexec_dir/lyrashield-refresh-egress" "$host_backup/refresh-egress.sh"
cp -p "$host_libexec_dir/lyrashield-capture-worker-stop-provenance" "$host_backup/capture-stop-provenance.sh"
# worker-env.sh has no host copy before the first promotion that ships it.
if [ -f "$host_assets_dir/worker-env.sh" ]; then
  cp -p "$host_assets_dir/worker-env.sh" "$host_backup/worker-env.sh"
fi
cp -p "$systemd_dir/lyrashield-worker.service" "$host_backup/lyrashield-worker.service"
cp -p "$systemd_dir/lyrashield-worker-secrets.service" "$host_backup/lyrashield-worker-secrets.service"
cp -p "$systemd_dir/lyrashield-worker-egress.service" "$host_backup/lyrashield-worker-egress.service"
cp -p "$systemd_dir/lyrashield-worker-egress-refresh.service" "$host_backup/lyrashield-worker-egress-refresh.service"
cp -p "$systemd_dir/lyrashield-worker-egress-refresh.timer" "$host_backup/lyrashield-worker-egress-refresh.timer"
host_assets_changed=1
install -m 0755 "$asset_stage/run-worker.sh" "$host_libexec_dir/lyrashield-run-worker"
install -d -m 0755 "$host_assets_dir"
install -m 0644 "$asset_stage/worker-env.sh" "$host_assets_dir/worker-env.sh"
install -m 0755 "$asset_stage/refresh-secrets.sh" "$host_libexec_dir/lyrashield-refresh-secrets"
install -m 0755 "$asset_stage/refresh-egress.sh" "$host_libexec_dir/lyrashield-refresh-egress"
install -m 0755 "$asset_stage/capture-stop-provenance.sh" "$host_libexec_dir/lyrashield-capture-worker-stop-provenance"
install -m 0644 "$asset_stage/lyrashield-worker.service" "$systemd_dir/lyrashield-worker.service"
install -m 0644 "$asset_stage/lyrashield-worker-secrets.service" "$systemd_dir/lyrashield-worker-secrets.service"
install -m 0644 "$asset_stage/lyrashield-worker-egress.service" "$systemd_dir/lyrashield-worker-egress.service"
install -m 0644 "$asset_stage/lyrashield-worker-egress-refresh.service" "$systemd_dir/lyrashield-worker-egress-refresh.service"
install -m 0644 "$asset_stage/lyrashield-worker-egress-refresh.timer" "$systemd_dir/lyrashield-worker-egress-refresh.timer"
systemctl daemon-reload

cp -p "$config" "$backup"
temporary=$(mktemp "${config}.XXXXXX")
awk -v image="$target" 'BEGIN { found=0 } /^LYRASHIELD_WORKER_IMAGE=/ { print "LYRASHIELD_WORKER_IMAGE=" image; found=1; next } { print } END { if (!found) exit 1 }' "$config" > "$temporary"
chmod 0600 "$temporary"
chown root:root "$temporary"
mv "$temporary" "$config"
config_changed=1

promotion_step=restarting-worker
systemctl reset-failed "$service" || true
systemctl restart "$service"
promotion_step=checking-restarted-worker
wait_healthy
[ "$(docker inspect "$container" --format '{{.Config.Image}}')" = "$target" ]
[ "$(docker exec "$container" printenv LYRASHIELD_PRODUCT_REVISION)" = "$expected_app" ]
[ "$(docker exec "$container" printenv LYRASHIELD_ENGINE_REVISION)" = "$expected_engine" ]
[ "$(docker exec "$container" printenv LYRASHIELD_WORKER_IMAGE_DIGEST)" = "${target##*@}" ]
promotion_step=checking-scan-readiness
curl --fail --silent --show-error --max-time 10 https://app.lyrashieldai.com/api/ready/scans >/dev/null

promotion_step=restoring-worker-units
restore_timer
# Promotion owns these systemd units. Repair disabled or previously inactive
# units before reopening scan admission so the next rollout needs no VM step.
systemctl enable "$service" "$timer"
systemctl start "$timer"
systemctl is-active --quiet "$service"
systemctl is-enabled --quiet "$service"
systemctl is-active --quiet "$timer"
systemctl is-enabled --quiet "$timer"
echo "Worker service state: active enabled"
echo "Worker egress refresh timer state: active enabled"
promotion_step=resuming-admission
if [ "$admission_stop_owned" -eq 1 ]; then
  resume_admission
fi
promotion_complete=1
trap - EXIT HUP INT TERM
cleanup_host_assets
echo "Worker promotion passed for ${target##*@}"
