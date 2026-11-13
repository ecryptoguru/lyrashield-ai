#!/bin/sh
# Bounded diagnostics for an operator-approved Azure VM Run Command.
# Only fixed status fields and closed error categories are emitted; raw
# journal, receipt, environment, and Redis values are never printed.
set -eu

run_id=${1-}
source_sha=${2-}
expected_owner=${3-}
case "$run_id" in ''|*[!0-9]*) printf 'receipt_probe_status=PIN_INVALID\n'; exit 0;; esac
case "$source_sha" in *[!a-f0-9]*) printf 'receipt_probe_status=PIN_INVALID\n'; exit 0;; esac
[ "${#source_sha}" -eq 40 ] || { printf 'receipt_probe_status=PIN_INVALID\n'; exit 0; }
case "$expected_owner" in "$run_id":[1-9]* ) ;; *) printf 'receipt_probe_status=PIN_INVALID\n'; exit 0;; esac
case "$expected_owner" in *[!0-9:]*) printf 'receipt_probe_status=PIN_INVALID\n'; exit 0;; esac
owner_attempt=${expected_owner#*:}
case "$owner_attempt" in ''|*[!0-9]*) printf 'receipt_probe_status=PIN_INVALID\n'; exit 0;; esac

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
elif grep -Eiq 'redis[^[:cntrl:]]*(econnrefused|econnreset|etimedout|timeout|unavailable|refused)|\b(econnrefused|econnreset|etimedout)\b[^[:cntrl:]]*(6379|redis)' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=REDIS_CONNECTIVITY
elif grep -Eiq 'database[^[:cntrl:]]*(econnrefused|econnreset|etimedout|timeout|unavailable|refused)|postgres[^[:cntrl:]]*(econnrefused|econnreset|etimedout|timeout|unavailable|refused)|\b(econnrefused|econnreset|etimedout)\b[^[:cntrl:]]*(5432|postgres|database)' "$diagnostic_dir/status" "$diagnostic_dir/journal"; then
  category=DATABASE_CONNECTIVITY
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
  printf 'receipt_probe_status=RECEIPT_MISSING\nreceipt_present=false\nredis_admission_owner_match=unavailable\n'
  exit 0
fi
[ "$(stat -c '%u:%a' "$receipt" 2>/dev/null || true)" = 0:600 ] || {
  printf 'receipt_probe_status=RECEIPT_METADATA_INVALID\nreceipt_present=true\nreceipt_metadata=invalid\nredis_admission_owner_match=unavailable\n'
  exit 0
}

# Parse and compare the stop value in memory. Only whitelisted receipt fields
# and the equality result are printed; admissionStopValue itself is never output.
LYRASHIELD_WORKER_IMAGE=$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' "$config" 2>/dev/null | head -n 1 2>/dev/null)
case "$LYRASHIELD_WORKER_IMAGE" in *@sha256:*) worker_digest=${LYRASHIELD_WORKER_IMAGE##*@sha256:};; *) worker_digest=;; esac
case "$worker_digest" in *[!a-f0-9]*|'') worker_digest=;; esac
[ "${#worker_digest}" -eq 64 ] || {
  printf 'receipt_probe_status=IMAGE_PIN_INVALID\nreceipt_present=true\nreceipt_metadata=unavailable\nreceipt_matches_expected=unavailable\nredis_admission_owner_match=unavailable\n'
  exit 0
}
if ! timeout --foreground 5s docker image inspect "$LYRASHIELD_WORKER_IMAGE" >/dev/null 2>&1; then
  printf 'receipt_probe_status=IMAGE_NOT_LOCAL\nreceipt_present=true\nreceipt_metadata=unavailable\nreceipt_matches_expected=unavailable\nredis_admission_owner_match=unavailable\n'
  exit 0
fi
redis_environment_file=$diagnostic_dir/redis.env
if ! awk -F= '/^REDIS_URL=/ { count++; value=$0; raw=substr($0, index($0, "=")+1) } END { if (count != 1 || raw !~ /^rediss?:\/\/[^[:space:]]+$/) exit 1; print value }' \
  "$environment_file" >"$redis_environment_file" 2>/dev/null; then
  redis_probe_mode=ambiguous
  docker_network=none
else
  redis_probe_mode=connected
  docker_network=bridge
fi
chmod 600 "$redis_environment_file"
diagnostic_code='
import fs from "node:fs";
import Redis from "ioredis";
const [runId, sourceSha, expectedOwner, redisMode] = process.argv.slice(1);
const emit = (status) => console.log("receipt_probe_status=" + status);
let receipt;
try {
  receipt = JSON.parse(fs.readFileSync("/run/cutover-receipt.json", "utf8"));
} catch {
  emit("RECEIPT_READ_OR_PARSE");
  console.log("receipt_present=unavailable");
  console.log("receipt_metadata=unavailable");
  console.log("receipt_matches_expected=unavailable");
  console.log("redis_admission_owner_match=unavailable");
  process.exit(0);
}
if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || typeof receipt.admissionStopValue !== "string" || !receipt.admissionStopValue) {
  emit("RECEIPT_METADATA_INVALID");
  console.log("receipt_present=true");
  console.log("receipt_metadata=invalid");
  console.log("receipt_matches_expected=unavailable");
  console.log("redis_admission_owner_match=unavailable");
  process.exit(0);
}
const clean = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : "invalid";
const attempts = Array.isArray(receipt.attempts) && receipt.attempts.length <= 10 && receipt.attempts.every((n) => Number.isSafeInteger(n) && n > 0) ? receipt.attempts : [];
const phase = ["intent", "claimed", "writers-stopped", "candidate", "resuming", "completed"].includes(receipt.phase) ? receipt.phase : "invalid";
const owner = clean(receipt.owner, /^[0-9]+:[1-9][0-9]*$/);
const receiptRunId = clean(receipt.runId, /^[0-9]+$/);
const revision = clean(receipt.productRevision, /^[a-f0-9]{40}$/);
const metadata = { phase, owner, runId: receiptRunId, sourceSha: revision, attempts, lastAttempt: Number.isSafeInteger(receipt.lastAttempt) && receipt.lastAttempt > 0 ? receipt.lastAttempt : "invalid" };
console.log("receipt_present=true");
console.log("receipt_metadata=" + JSON.stringify(metadata));
console.log("receipt_matches_expected=" + String(metadata.runId === runId && metadata.sourceSha === sourceSha && metadata.owner === expectedOwner));
if (redisMode === "ambiguous") {
  emit("REDIS_URL_AMBIGUOUS");
  console.log("redis_admission_owner_match=unavailable");
  process.exit(0);
}
const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
let stopValue;
try {
  stopValue = await redis.get("lyrashield:scan-admission:stopped");
} catch {
  emit("REDIS_UNREACHABLE");
  console.log("redis_admission_owner_match=unavailable");
  redis.disconnect();
  process.exit(0);
}
let stop;
try {
  stop = typeof stopValue === "string" ? JSON.parse(stopValue) : null;
} catch {
  emit("REDIS_RESPONSE_INVALID");
  console.log("redis_admission_owner_match=unavailable");
  redis.disconnect();
  process.exit(0);
}
console.log("redis_admission_owner_match=" + String(stopValue === receipt.admissionStopValue && stop?.owner === receipt.owner && stop?.runId === receipt.runId && stop?.productRevision === receipt.productRevision));
emit("OK");
try { await redis.quit(); } catch { redis.disconnect(); }
'
# shellcheck disable=SC2086
docker_diagnostic_output=$(timeout --foreground 30s docker run --pull=never --rm --read-only --network "$docker_network" \
  --user 0:0 --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 64 --memory 128m --cpus 1 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --volume "$receipt:/run/cutover-receipt.json:ro" \
  --env-file "$redis_environment_file" \
  "$LYRASHIELD_WORKER_IMAGE" node --input-type=module -e "$diagnostic_code" \
  "$run_id" "$source_sha" "$expected_owner" "$redis_probe_mode" 2>&1) || true
printf '%s\n' "$docker_diagnostic_output" | awk '
  /^receipt_probe_status=(PIN_INVALID|IMAGE_PIN_INVALID|IMAGE_NOT_LOCAL|REDIS_URL_AMBIGUOUS|DOCKER_RUN_FAILED|RECEIPT_READ_OR_PARSE|RECEIPT_METADATA_INVALID|RECEIPT_MISSING|REDIS_UNREACHABLE|REDIS_RESPONSE_INVALID|OK)$/ { print; probe=$0; next }
  $0 == "receipt_present=true" { print; present=1; next }
  $0 == "receipt_matches_expected=true" || $0 == "receipt_matches_expected=false" { print; expected=1; next }
  $0 == "redis_admission_owner_match=true" || $0 == "redis_admission_owner_match=false" || $0 == "redis_admission_owner_match=unavailable" { print; redis=1; next }
  $0 ~ /^receipt_metadata=\{"phase":"(intent|claimed|writers-stopped|candidate|resuming|completed)","owner":"[0-9]+:[0-9]+","runId":"[0-9]+","sourceSha":"([a-f0-9]+|invalid)","attempts":\[[0-9,]*\],"lastAttempt":([0-9]+|"invalid")\}$/ { print; metadata=1; next }
  END {
    if (!probe) print "receipt_probe_status=DOCKER_RUN_FAILED"
    if (!present) print "receipt_present=unavailable"
    if (!metadata) print "receipt_metadata=unavailable"
    if (!expected) print "receipt_matches_expected=unavailable"
    if (!redis) print "redis_admission_owner_match=unavailable"
  }
'
