#!/bin/sh
# Bounded diagnostics for an operator-approved Azure VM Run Command.
# Only fixed status fields and closed error categories are emitted; raw
# journal, receipt, environment, and Redis values are never printed.
set -eu

run_id=${1:?workflow run ID}
source_sha=${2:?deployment source SHA}
expected_owner=${3:?original receipt owner}
case "$run_id" in ''|*[!0-9]*) exit 2;; esac
case "$source_sha" in *[!a-f0-9]*) exit 2;; esac
[ "${#source_sha}" -eq 40 ] || exit 2
case "$expected_owner" in "$run_id":*[!0-9:]*|*[!0-9:]*|'') exit 2;; esac
case "$expected_owner" in "$run_id":*) ;; *) exit 2;; esac

service=lyrashield-worker.service
timer=lyrashield-worker-egress-refresh.timer
egress_service=lyrashield-worker-egress-refresh.service
container=lyrashield-worker
config=${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}
environment_file=${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}
receipt=${LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE:-/var/lib/lyrashield/webhook-claims-cutover.json}

safe_state() {
  case "$1" in active|inactive|failed|activating|deactivating|reloading|unknown|enabled|disabled|static|masked|indirect|generated|alias|linked|linked-runtime|transient|bad|created|restarting|dead|paused|removing|exited) printf '%s' "$1";; *) printf unknown;; esac
}
unit_state() {
  unit=$1
  active=$(timeout --foreground 5s systemctl is-active "$unit" 2>/dev/null || true)
  enabled=$(timeout --foreground 5s systemctl is-enabled "$unit" 2>/dev/null || true)
  printf '%s active=%s enabled=%s\n' "$unit" "$(safe_state "$active")" "$(safe_state "$enabled")"
}

unit_state "$service"
unit_state "$timer"
unit_state "$egress_service"

container_state=$(timeout --foreground 5s docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || true)
container_health=$(timeout --foreground 5s docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' 2>/dev/null || true)
image_ref=$(timeout --foreground 5s docker inspect "$container" --format '{{.Config.Image}}' 2>/dev/null || true)
image_digest=$(printf '%s' "$image_ref" | sed -n 's/.*@\(sha256:[a-f0-9]\{64\}\)$/\1/p')
[ -n "$image_digest" ] || image_digest=unavailable
printf 'worker_container_state=%s\n' "$(safe_state "$container_state")"
case "$container_health" in healthy|unhealthy|starting|no-healthcheck) ;; *) container_health=unavailable;; esac
printf 'worker_container_health=%s\nworker_image_digest=%s\n' "$container_health" "$image_digest"

read_runtime_identity() {
  key=$1
  value=$(timeout --foreground 5s docker exec "$container" printenv "$key" 2>/dev/null || true)
  case "$key" in
    LYRASHIELD_PRODUCT_REVISION|LYRASHIELD_ENGINE_REVISION)
      case "$value" in *[!a-f0-9]*|'') value=unavailable;; esac
      [ "${#value}" -eq 40 ] || value=unavailable
      ;;
    LYRASHIELD_WORKER_IMAGE_DIGEST)
      case "$value" in sha256:*) ;; *) value=unavailable;; esac
      case "$value" in *[!a-f0-9:]*) value=unavailable;; esac
      [ "${#value}" -eq 71 ] || value=unavailable
      ;;
  esac
  printf '%s=%s\n' "$key" "$value"
}
read_runtime_identity LYRASHIELD_PRODUCT_REVISION
read_runtime_identity LYRASHIELD_ENGINE_REVISION
read_runtime_identity LYRASHIELD_WORKER_IMAGE_DIGEST

diagnostic_dir=$(mktemp -d)
chmod 700 "$diagnostic_dir"
trap 'rm -rf "$diagnostic_dir"' EXIT HUP INT TERM
timeout --foreground 10s systemctl status --no-pager "$service" >"$diagnostic_dir/status" 2>&1 || true
timeout --foreground 10s journalctl -u "$service" -n 50 --no-pager --output=cat >"$diagnostic_dir/journal" 2>&1 || true
if grep -Eiq 'out of memory|oom-kill|killed process' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=OOM
elif grep -Eiq 'cannot find module|err_module_not_found' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=MODULE_MISSING
elif grep -Eiq 'econnrefused|database.*(timeout|unavailable|refused)' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=DATABASE_CONNECTIVITY
elif grep -Eiq 'redis.*(timeout|unavailable|refused)|econnreset' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=REDIS_CONNECTIVITY
elif grep -Eiq 'certificate|tls handshake|ssl error' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=TLS_CERTIFICATE
elif grep -Eiq 'permission denied|access denied' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=PERMISSION
elif grep -Eiq 'address already in use|eaddrinuse|cannot assign requested address' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=PORT_BIND
elif grep -Eiq 'unauthorized|forbidden|authentication failed' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=AUTHENTICATION
elif grep -Eiq 'unhealthy|health check failed|start-limit-hit' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=HEALTHCHECK
else
  category=UNCLASSIFIED
fi
printf 'worker_health_error_category=%s\n' "$category"

if [ ! -f "$receipt" ] || [ -L "$receipt" ]; then
  printf 'receipt_present=false\nredis_admission_owner_match=unavailable\n'
  exit 0
fi
[ "$(stat -c '%u:%a' "$receipt" 2>/dev/null || true)" = 0:600 ] || {
  printf 'receipt_present=true\nreceipt_metadata=invalid\nredis_admission_owner_match=unavailable\n'
  exit 0
}

# Parse and compare the stop value in memory. Only whitelisted receipt fields
# and the equality result are printed; admissionStopValue itself is never output.
set -a
. "$config"
set +a
case "${LYRASHIELD_WORKER_IMAGE:-}" in *@sha256:*) worker_digest=${LYRASHIELD_WORKER_IMAGE##*@sha256:};; *) worker_digest=;; esac
case "$worker_digest" in *[!a-f0-9]*|'') worker_digest=;; esac
[ "${#worker_digest}" -eq 64 ] || {
  printf 'receipt_present=true\nreceipt_metadata=unavailable\nreceipt_matches_expected=unavailable\nredis_admission_owner_match=unavailable\n'
  exit 0
}
if ! timeout --foreground 5s docker image inspect "$LYRASHIELD_WORKER_IMAGE" >/dev/null 2>&1; then
  printf 'receipt_present=true\nreceipt_metadata=unavailable\nreceipt_matches_expected=unavailable\nredis_admission_owner_match=unavailable\n'
  exit 0
fi
redis_environment_file=$diagnostic_dir/redis.env
if ! awk '/^REDIS_URL=/ { count++; if (count == 1) print } END { exit count != 1 }' \
  "$environment_file" >"$redis_environment_file"; then
  printf 'receipt_present=true\nreceipt_metadata=unavailable\nreceipt_matches_expected=unavailable\nredis_admission_owner_match=unavailable\n'
  exit 0
fi
chmod 600 "$redis_environment_file"
diagnostic_code='import fs from "node:fs"; import Redis from "ioredis"; const [runId,sourceSha,expectedOwner]=process.argv.slice(1); const r=JSON.parse(fs.readFileSync("/run/cutover-receipt.json","utf8")); const clean=(v,re)=>typeof v==="string"&&re.test(v)?v:"invalid"; const attempts=Array.isArray(r.attempts)&&r.attempts.length<=10&&r.attempts.every(n=>Number.isSafeInteger(n)&&n>0)?r.attempts:[]; const phase=["intent","claimed","writers-stopped","candidate","resuming","completed"].includes(r.phase)?r.phase:"invalid"; const owner=clean(r.owner,/^[0-9]+:[1-9][0-9]*$/); const receiptRunId=clean(r.runId,/^[0-9]+$/); const revision=clean(r.productRevision,/^[a-f0-9]{40}$/); const receipt={phase,owner,runId:receiptRunId,sourceSha:revision,attempts,lastAttempt:Number.isSafeInteger(r.lastAttempt)&&r.lastAttempt>0?r.lastAttempt:"invalid"}; console.log("receipt_present=true"); console.log("receipt_metadata="+JSON.stringify(receipt)); console.log("receipt_matches_expected="+String(receipt.runId===runId&&receipt.sourceSha===sourceSha&&receipt.owner===expectedOwner)); let match="unavailable"; try { const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1,connectTimeout:5000}); try { const value=await redis.get("lyrashield:scan-admission:stopped"); const stop=typeof value==="string"?JSON.parse(value):null; match=String(value===r.admissionStopValue&&stop?.owner===r.owner&&stop?.runId===r.runId&&stop?.productRevision===r.productRevision); } finally { await redis.quit(); } } catch { match="unavailable"; } console.log("redis_admission_owner_match="+match);'
# shellcheck disable=SC2086
docker_diagnostic_output=$(timeout --foreground 30s docker run --pull=never --rm --read-only --network bridge \
  --user 0:0 --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 128m --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --volume "$receipt:/run/cutover-receipt.json:ro" \
  --env-file "$redis_environment_file" \
  "$LYRASHIELD_WORKER_IMAGE" node --input-type=module -e "$diagnostic_code" \
  "$run_id" "$source_sha" "$expected_owner" 2>&1) || true
printf '%s\n' "$docker_diagnostic_output" | awk '
  $0 == "receipt_present=true" { print; present=1; next }
  $0 == "receipt_matches_expected=true" || $0 == "receipt_matches_expected=false" { print; expected=1; next }
  $0 == "redis_admission_owner_match=true" || $0 == "redis_admission_owner_match=false" || $0 == "redis_admission_owner_match=unavailable" { print; redis=1; next }
  $0 ~ /^receipt_metadata=\{"phase":"(intent|claimed|writers-stopped|candidate|resuming|completed)","owner":"[0-9]+:[0-9]+","runId":"[0-9]+","sourceSha":"([a-f0-9]+|invalid)","attempts":\[[0-9,]*\],"lastAttempt":([0-9]+|"invalid")\}$/ { print; metadata=1; next }
  END {
    if (!present) print "receipt_present=unavailable"
    if (!metadata) print "receipt_metadata=unavailable"
    if (!expected) print "receipt_matches_expected=unavailable"
    if (!redis) print "redis_admission_owner_match=unavailable"
  }
'
