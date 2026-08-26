#!/bin/sh
set -eu

target=${1:?worker image digest reference is required}
expected_app=${2:?product revision is required}
expected_engine=${3:?engine revision is required}
config=${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}
environment_file=${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}
container=lyrashield-worker
timer=lyrashield-worker-egress-refresh.timer
service=lyrashield-worker.service

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
admission_stopped=0
config_changed=0
promotion_complete=0

redis_eval() {
  docker exec -w /app/apps/worker "$container" node --input-type=module -e "$1"
}

resume_admission() {
  redis_eval 'const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:null}); await redis.del("lyrashield:scan-admission:stopped"); await redis.quit();'
  admission_stopped=0
}

wait_healthy() {
  for _ in $(seq 1 600); do
    health=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)
    [ "$health" = healthy ] && return 0
    sleep 1
  done
  return 1
}

restore_timer() {
  [ "$timer_was_active" -eq 0 ] || systemctl start "$timer"
}

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$promotion_complete" -ne 1 ]; then
    if [ "$config_changed" -eq 1 ]; then
      cp -p "$backup" "$config"
      systemctl reset-failed "$service" || true
      systemctl restart "$service" || true
      if wait_healthy && [ "$admission_stopped" -eq 1 ]; then
        resume_admission || true
      fi
    elif [ "$admission_stopped" -eq 1 ]; then
      resume_admission || true
    fi
    restore_timer || true
    echo "Worker promotion failed; prior digest restored" >&2
  fi
  exit "$status"
}
trap rollback EXIT HUP INT TERM

# Keep DNS refresh from racing the bounded replacement window. The timer is
# restored after success or rollback.
systemctl stop "$timer"
for _ in $(seq 1 60); do
  systemctl is-active --quiet lyrashield-worker-egress-refresh.service || break
  sleep 1
done
systemctl is-active --quiet lyrashield-worker-egress-refresh.service && {
  echo "Egress refresh did not quiesce" >&2
  exit 1
}
wait_healthy

redis_eval 'const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:null}); await redis.set("lyrashield:scan-admission:stopped",JSON.stringify({operator:"github-actions",reason:"worker-promotion",at:new Date().toISOString()})); await redis.quit();'
admission_stopped=1

preflight=$(docker exec -w /app/apps/worker "$container" node --import tsx --input-type=module -e 'const {getSystemPrisma}=await import("@lyrashield/db"); const {getScanQueue,getWebhookTrackRetryQueue,closeRedis}=await import("@lyrashield/integrations"); const prisma=getSystemPrisma(); const scanQueue=getScanQueue(); const webhookQueue=getWebhookTrackRetryQueue(); try { const [nonterminal,scan,webhook]=await Promise.all([prisma.scan.count({where:{status:{in:["QUEUED","PREFLIGHT","RUNNING","VERIFYING","REQUIRES_APPROVAL"]}}}),scanQueue.getJobCounts("wait","active","delayed","prioritized"),webhookQueue.getJobCounts("wait","active","delayed","prioritized")]); console.log(JSON.stringify({nonterminal,scan,webhook})); } finally { await Promise.allSettled([prisma.$disconnect(),scanQueue.close(),webhookQueue.close(),closeRedis()]); }')
expected='{"nonterminal":0,"scan":{"wait":0,"active":0,"delayed":0,"prioritized":0},"webhook":{"wait":0,"active":0,"delayed":0,"prioritized":0}}'
[ "$preflight" = "$expected" ] || {
  echo "Worker promotion requires empty scan and webhook queues" >&2
  exit 1
}

ghcr_username=$(sed -n 's/^GHCR_USERNAME=//p' "$config" | head -n 1)
ghcr_token=$(sed -n 's/^GHCR_TOKEN=//p' "$environment_file" | head -n 1)
[ -n "$ghcr_username" ]
[ -n "$ghcr_token" ]
printf '%s\n' "$ghcr_token" | docker login ghcr.io -u "$ghcr_username" --password-stdin >/dev/null 2>&1
docker pull "$target" >/dev/null
app_label=$(docker image inspect "$target" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
engine_label=$(docker image inspect "$target" --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}')
[ "$app_label" = "$expected_app" ]
[ "$engine_label" = "$expected_engine" ]

cp -p "$config" "$backup"
temporary=$(mktemp "${config}.XXXXXX")
awk -v image="$target" 'BEGIN { found=0 } /^LYRASHIELD_WORKER_IMAGE=/ { print "LYRASHIELD_WORKER_IMAGE=" image; found=1; next } { print } END { if (!found) exit 1 }' "$config" > "$temporary"
chmod 0600 "$temporary"
chown root:root "$temporary"
mv "$temporary" "$config"
config_changed=1

systemctl reset-failed "$service" || true
systemctl restart "$service"
wait_healthy
[ "$(docker inspect "$container" --format '{{.Config.Image}}')" = "$target" ]
[ "$(docker exec "$container" printenv LYRASHIELD_PRODUCT_REVISION)" = "$expected_app" ]
[ "$(docker exec "$container" printenv LYRASHIELD_ENGINE_REVISION)" = "$expected_engine" ]
[ "$(docker exec "$container" printenv LYRASHIELD_WORKER_IMAGE_DIGEST)" = "${target##*@}" ]
curl --fail --silent --show-error --max-time 10 https://app.lyrashieldai.com/api/ready/scans >/dev/null

resume_admission
restore_timer
promotion_complete=1
trap - EXIT HUP INT TERM
echo "Worker promotion passed for ${target##*@}"
