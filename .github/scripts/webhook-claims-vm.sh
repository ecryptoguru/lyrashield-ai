#!/bin/sh
# shellcheck disable=SC2016
set -eu
# JavaScript dollar names are literal; they must not expand in the host shell.
phase=${1:?phase}
migration_identity=${5:-}
revision=${2:?product revision}
owner=${3:?run owner}
run_id=${4:?run ID}
case "$revision" in *[!a-f0-9]*|'') exit 1;; esac
[ ${#revision} -eq 40 ] || exit 1
case "$run_id" in *[!0-9]*|'') exit 1;; esac
case "$owner" in "$run_id":*[!0-9:]*|*[!0-9:]*|'') exit 1;; esac
case "$owner" in "$run_id":*) ;; *) exit 1;; esac
attempt=${owner#*:}
case "$attempt" in *[!0-9]*|'') exit 1;; esac
receipt=${LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE:-/var/lib/lyrashield/webhook-claims-cutover.json}
receipt_dir=$(dirname "$receipt")
stop_receipt=${LYRASHIELD_WORKER_STOP_RECEIPT_FILE:-/run/lyrashield/worker-stop-provenance.json}
config=${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}
environment_file=${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}
container=lyrashield-worker
timer=lyrashield-worker-egress-refresh.timer
service=lyrashield-worker.service
# shellcheck disable=SC1090
. "${LYRASHIELD_WORKER_ENV_LIB:?worker env library}"
image=$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' "$config")
case "$image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) exit 1;; esac
oneshot() {
  code=$1
  shift
  env_args=$(lyrashield_worker_env_args "$config" "$environment_file")
  # Same bounded environment as promotion; no socket or scan files mounted.
  # shellcheck disable=SC2086
  docker run --rm --network bridge --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    --env-file "$environment_file" $env_args --env TMPDIR=/tmp \
    -w /app/apps/worker "$image" node --import tsx --input-type=module -e "$code" "$@"
}
live_environment_hashes() {
  docker exec -w /app/apps/worker "$container" node --input-type=module -e 'import {createHash} from "node:crypto"; const hash=(value)=>createHash("sha256").update(value??"").digest("hex"); const logical=(value)=>{try{const url=new URL(value);const db=decodeURIComponent(url.pathname.slice(1));if(!["postgres:","postgresql:"].includes(url.protocol)||!url.hostname||!["","5432","6432"].includes(url.port)||!db)throw new Error();return hash(JSON.stringify([url.hostname.toLowerCase(),db,url.searchParams.get("schema")||"public"]));}catch{throw new Error("Invalid worker database identity");}}; console.log(JSON.stringify({databaseLogicalIdentitySha256:logical(process.env.DATABASE_URL),databaseSystemLogicalIdentitySha256:logical(process.env.DATABASE_SYSTEM_URL||process.env.DATABASE_URL),databaseUrlSha256:hash(process.env.DATABASE_URL),databaseSystemUrlSha256:hash(process.env.DATABASE_SYSTEM_URL),redisUrlSha256:hash(process.env.REDIS_URL)}));'
}
assert_running_environment() {
  [ "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$image" ] || exit 1
  live_hashes=$(live_environment_hashes)
  oneshot 'import {createHash} from "node:crypto"; const expected=JSON.parse(process.argv[1]); const hash=(value)=>createHash("sha256").update(value??"").digest("hex"); if(expected.databaseUrlSha256!==hash(process.env.DATABASE_URL) || expected.databaseSystemUrlSha256!==hash(process.env.DATABASE_SYSTEM_URL) || expected.redisUrlSha256!==hash(process.env.REDIS_URL)) throw new Error("Running worker and preflight environment mismatch");' "$live_hashes"
}
assert_migration_database() {
  case "$migration_identity" in *[!a-f0-9]*|'') exit 1;; esac
  [ ${#migration_identity} -eq 64 ] || exit 1
  if systemctl is-active --quiet "$service"; then
    assert_running_environment
  else
    [ ! -L "$receipt" ] && [ "$(stat -c '%u:%a' "$receipt")" = 0:600 ] || exit 1
    saved=$(cat "$receipt")
    owner=$(oneshot 'const [saved,revision,runId]=process.argv.slice(1); const receipt=JSON.parse(saved); if(receipt.runId!==runId || receipt.productRevision!==revision) throw new Error("Existing cutover receipt required"); console.log(receipt.owner);' "$saved" "$revision" "$run_id")
    assert_receipt_identity
  fi
  oneshot 'import {createHash} from "node:crypto"; const identity=(value)=>{try {const url=new URL(value);const database=decodeURIComponent(url.pathname.slice(1));if(!["postgres:","postgresql:"].includes(url.protocol)||!url.hostname||!["","5432","6432"].includes(url.port)||!database)throw new Error();return createHash("sha256").update(JSON.stringify([url.hostname.toLowerCase(),database,url.searchParams.get("schema")||"public"])).digest("hex");}catch{throw new Error("Invalid migration database identity configuration");}};const expected=process.argv[1];if(identity(process.env.DATABASE_URL)!==expected || identity(process.env.DATABASE_SYSTEM_URL||process.env.DATABASE_URL)!==expected)throw new Error("Migration host/database/schema differs from old worker; correct configuration before maintenance");' "$migration_identity"
}
assert_receipt_identity() {
  oneshot 'const [saved,revision,owner,runId]=process.argv.slice(1); const receipt=JSON.parse(saved); if(receipt.phase==="completed") throw new Error("Completed cutover cannot re-enter maintenance; start a current-main release"); const stop=JSON.parse(receipt.admissionStopValue); const {createHash}=await import("node:crypto"); const hash=(value)=>createHash("sha256").update(value??"").digest("hex"); if(receipt.databaseUrlSha256!==hash(process.env.DATABASE_URL) || receipt.databaseSystemUrlSha256!==hash(process.env.DATABASE_SYSTEM_URL) || receipt.redisUrlSha256!==hash(process.env.REDIS_URL) || receipt.owner!==owner || receipt.runId!==runId || receipt.productRevision!==revision || stop.owner!==owner || stop.runId!==runId || stop.productRevision!==revision || stop.reason!=="webhook-claims-cutover" || stop.operator!=="github-actions") throw new Error("Cutover receipt identity mismatch");' "$saved" "$revision" "$owner" "$run_id"
}
verify_retained_candidate() {
  previous=$(oneshot 'console.log(JSON.parse(process.argv[1]).previousWorkerImage);' "$saved")
  if [ "$image" != "$previous" ]; then
    product=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
    engine=$(docker image inspect --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}' "$image")
    oneshot 'const [saved,image,revision,engine]=process.argv.slice(1); const receipt=JSON.parse(saved); const {WEBHOOK_TRACK_CLAIM_PROTOCOL}=await import("@lyrashield/billing"); if(![receipt.candidateWorkerImage,receipt.previousCandidateWorkerImage].includes(image)||receipt.candidateProductRevision!==revision||receipt.productRevision!==revision||receipt.candidateEngineRevision!==engine||receipt.candidateWebhookTrackClaimProtocol!=="durable-claims/2"||WEBHOOK_TRACK_CLAIM_PROTOCOL!=="durable-claims/2")throw new Error("Retained candidate capability identity mismatch");' "$saved" "$image" "$product" "$engine"
  fi
}
assert_receipt() {
  [ ! -L "$receipt" ] && [ "$(stat -c '%u:%a' "$receipt")" = 0:600 ] || exit 1
  saved=$(cat "$receipt")
  oneshot 'const [saved,revision,owner,runId]=process.argv.slice(1); const receipt=JSON.parse(saved); const {createHash}=await import("node:crypto"); const hash=(value)=>createHash("sha256").update(value??"").digest("hex"); if(receipt.databaseUrlSha256!==hash(process.env.DATABASE_URL) || receipt.databaseSystemUrlSha256!==hash(process.env.DATABASE_SYSTEM_URL) || receipt.redisUrlSha256!==hash(process.env.REDIS_URL)) throw new Error("Cutover connection identity changed"); const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { const value=await redis.get("lyrashield:scan-admission:stopped"); const stop=JSON.parse(receipt.admissionStopValue); if(receipt.owner!==owner || receipt.runId!==runId || receipt.productRevision!==revision || value!==receipt.admissionStopValue || stop.owner!==owner || stop.runId!==runId || stop.productRevision!==revision || stop.reason!=="webhook-claims-cutover" || stop.operator!=="github-actions") throw new Error("Owned cutover receipt mismatch"); } finally { await redis.quit(); }' "$saved" "$revision" "$owner" "$run_id"
}
assert_empty() {
  oneshot 'const {getSystemPrisma}=await import("@lyrashield/db"); const {getScanQueue,getWebhookTrackRetryQueue,closeRedis}=await import("@lyrashield/integrations"); const prisma=getSystemPrisma(); const scan=getScanQueue(); const webhook=getWebhookTrackRetryQueue(); try { const [count,a,b]=await Promise.all([prisma.scan.count({where:{status:{in:["QUEUED","PREFLIGHT","RUNNING","VERIFYING","REQUIRES_APPROVAL"]}}}),scan.getJobCounts("wait","active","delayed","prioritized","paused","waiting-children"),webhook.getJobCounts("wait","active","delayed","prioritized","paused","waiting-children")]); if(count!==0 || Object.values(a).some(Boolean) || Object.values(b).some(Boolean)) throw new Error("Cutover requires drained scans and retry queue"); } finally { await Promise.allSettled([prisma.$disconnect(),scan.close(),webhook.close(),closeRedis()]); }'
}
assert_tracks_terminal() {
  oneshot 'const {getSystemPrisma}=await import("@lyrashield/db"); const prisma=getSystemPrisma(); try { const [tracks]=await prisma.$queryRaw`SELECT count(*)::integer AS count FROM "WebhookEventTrack" WHERE status NOT IN (${"succeeded"},${"dead_letter"},${"reviewed"})`; if(tracks.count!==0) throw new Error("Nonterminal webhook tracks remain; complete existing work before automatic cutover"); } finally { await prisma.$disconnect(); }'
}
# Once all writers are stopped, require legacy scheduling values to be empty.
# The additive UTC migration then preserves NULLs without guessing historical
# timezone settings. A partial schema or remaining scheduled work fails closed.
assert_legacy_schedule_drained() {
  oneshot 'const {getSystemPrisma}=await import("@lyrashield/db"); const prisma=getSystemPrisma(); try { const [schema]=await prisma.$queryRaw`SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=${"WebhookEventTrack"} AND column_name IN (${"nextAttemptAtUtc"},${"leaseExpiresAtUtc"})`; if(schema.count!==2) { if(schema.count!==0) throw new Error("Partial webhook UTC schema; inspect migration state"); const [legacy]=await prisma.$queryRaw`SELECT count(*)::integer AS count FROM "WebhookEventTrack" WHERE "nextAttemptAt" IS NOT NULL OR "leaseExpiresAt" IS NOT NULL`; if(legacy.count!==0) throw new Error("Legacy webhook scheduling values remain; drain existing work before the first UTC migration"); } } finally { await prisma.$disconnect(); }'
}
assert_stopped() {
  [ "$(systemctl is-active "$service" || true)" = inactive ] || exit 1
  [ "$(systemctl is-enabled "$service" || true)" = disabled ] || exit 1
  remaining=$(docker ps -a --filter 'name=^/lyrashield-worker$' --format '{{.Names}}') || exit 1
  [ -z "$remaining" ] || exit 1
  [ "$(systemctl is-active "$timer" || true)" = inactive ] || exit 1
  [ "$(systemctl is-enabled "$timer" || true)" = disabled ] || exit 1
  [ "$(systemctl is-active lyrashield-worker-egress-refresh.service || true)" = inactive ] || exit 1
}
persist_phase() {
  saved=$(oneshot 'const [saved,phase,attempt]=process.argv.slice(1); const receipt=JSON.parse(saved); console.log(JSON.stringify({...receipt,phase,lastAttempt:Number(attempt),attempts:[...new Set([...(receipt.attempts??[]),Number(attempt)])]}));' "$saved" "$1" "$attempt")
  umask 077
  temporary=$(mktemp "$receipt_dir/webhook-claims-cutover.XXXXXX")
  printf '%s\n' "$saved" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$receipt"
}
recover_stop() {
  assert_receipt_identity
  verify_retained_candidate
  oneshot 'const receipt=JSON.parse(process.argv[1]); const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { const value=await redis.get("lyrashield:scan-admission:stopped"); if(value!==receipt.admissionStopValue) { if(value!==null || !["intent","resuming"].includes(receipt.phase)) throw new Error("Foreign or unproven admission state"); if(await redis.set("lyrashield:scan-admission:stopped",receipt.admissionStopValue,"NX")!=="OK") throw new Error("Admission ownership changed during recovery"); } } finally { await redis.quit(); }' "$saved"
}
emit_receipt() {
  oneshot 'const receipt=JSON.parse(process.argv[1]); console.log("ADMISSION_STOP_RECEIPT_BASE64="+Buffer.from(receipt.admissionStopValue).toString("base64")); console.log("ADMISSION_STOP_OWNER="+receipt.owner);' "$saved"
}
case "$phase" in
database)
  assert_migration_database
  echo WEBHOOK_MIGRATION_DATABASE_VERIFIED
  ;;
recovery|recovery-probe)
  completed_receipt="$receipt_dir/webhook-claims-cutover-completed-${run_id}.json"
  if [ ! -e "$receipt" ] && [ ! -L "$receipt" ]; then
    if [ -e "$completed_receipt" ] || [ -L "$completed_receipt" ]; then
      receipt=$completed_receipt
    elif [ "$phase" = recovery-probe ]; then
      oneshot 'const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { if(await redis.get("lyrashield:scan-admission:stopped")!==null) throw new Error("Admission stop exists without an owned cutover receipt"); } finally { await redis.quit(); }'
      echo 'WEBHOOK_RECOVERY_RECEIPT_ABSENT'
      exit 0
    else
      exit 1
    fi
  fi
  [ ! -L "$receipt" ] && [ "$(stat -c '%u:%a' "$receipt")" = 0:600 ] || exit 1
  saved=$(cat "$receipt")
  owner=$(oneshot 'const [saved,revision,runId,currentAttempt,phase]=process.argv.slice(1); const receipt=JSON.parse(saved); const match=/^([0-9]+):([1-9][0-9]*)$/.exec(receipt.owner??""); const attempts=receipt.attempts; const lastAttempt=receipt.lastAttempt; const attempt=Number(currentAttempt); const ownerAttempt=Number(match?.[2]); if(receipt.runId!==runId || receipt.productRevision!==revision || !match || match[1]!==runId || !Number.isSafeInteger(attempt) || attempt<1 || !Array.isArray(attempts) || attempts.length===0 || !attempts.every((value,index)=>Number.isSafeInteger(value)&&value>0&&value<=lastAttempt&&(index===0||value>attempts[index-1])) || new Set(attempts).size!==attempts.length || attempts[0]!==ownerAttempt || !attempts.includes(lastAttempt) || Math.max(...attempts)!==lastAttempt || ownerAttempt>lastAttempt || (phase==="recovery-probe" && lastAttempt>=attempt)) throw new Error("Existing original cutover receipt or attempt history required"); console.log(receipt.owner);' "$saved" "$revision" "$run_id" "$attempt" "$phase")
  assert_receipt_identity
  oneshot 'const receipt=JSON.parse(process.argv[1]); const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { const value=await redis.get("lyrashield:scan-admission:stopped"); if(value!==receipt.admissionStopValue && !(value===null && ["intent","resuming"].includes(receipt.phase))) throw new Error("Unproven original cutover state"); } finally { await redis.quit(); }' "$saved"
  echo 'WEBHOOK_RECOVERY_RECEIPT_VERIFIED'
  ;;
claim)
  completed_receipt="$receipt_dir/webhook-claims-cutover-completed-${run_id}.json"
  if [ ! -e "$receipt" ] && [ -f "$completed_receipt" ]; then
    [ ! -L "$completed_receipt" ] && [ "$(stat -c '%u:%a' "$completed_receipt")" = 0:600 ] || exit 1
    saved=$(cat "$completed_receipt")
    owner=$(oneshot 'const [saved,revision,runId]=process.argv.slice(1); const receipt=JSON.parse(saved); if(receipt.runId!==runId || receipt.productRevision!==revision || !new RegExp("^"+runId+":[0-9]+$").test(receipt.owner)) throw new Error("Foreign completed cutover receipt"); console.log(receipt.owner);' "$saved" "$revision" "$run_id")
    assert_receipt_identity
    cp -p "$completed_receipt" "$receipt"
  fi
  if [ -e "$receipt" ]; then
    [ ! -L "$receipt" ] && [ "$(stat -c '%u:%a' "$receipt")" = 0:600 ] || exit 1
    saved=$(cat "$receipt")
    owner=$(oneshot 'const [saved,revision,runId]=process.argv.slice(1); const receipt=JSON.parse(saved); if(receipt.runId!==runId || receipt.productRevision!==revision || !new RegExp("^"+runId+":[0-9]+$").test(receipt.owner)) throw new Error("Foreign cutover receipt cannot be adopted"); console.log(receipt.owner);' "$saved" "$revision" "$run_id")
    recover_stop
    assert_receipt
    persist_phase claimed
    if systemctl is-active --quiet "$service"; then assert_running_environment; else assert_stopped; fi
    emit_receipt
    exit 0
  fi
  systemctl is-active --quiet "$service"
  [ "$(docker inspect --format '{{.State.Running}}' "$container")" = true ]
  assert_running_environment
  # Read-only eligibility precedes the intent receipt and admission stop.
  # Retain post-quiescence checks: producers can race this observation.
  assert_empty
  assert_tracks_terminal
  assert_legacy_schedule_drained
  umask 077
  # Persist intent before claiming the stop. A crash leaves an explicit receipt,
  # never a fabricated authorization to resume a different operator's stop.
  saved=$(oneshot 'const [revision,owner,runId,image,hashes]=process.argv.slice(1); const value=JSON.stringify({operator:"github-actions",reason:"webhook-claims-cutover",owner,runId,productRevision:revision,at:new Date().toISOString()}); console.log(JSON.stringify({owner,runId,productRevision:revision,admissionStopValue:value,previousWorkerImage:image,phase:"intent",attempts:[Number(owner.split(":")[1])],lastAttempt:Number(owner.split(":")[1]),...JSON.parse(hashes)}));' "$revision" "$owner" "$run_id" "$image" "$live_hashes")
  temp=$(mktemp "$receipt_dir/webhook-claims-cutover.XXXXXX")
  printf '%s\n' "$saved" > "$temp"
  chmod 600 "$temp"
  mv "$temp" "$receipt"
  oneshot 'const saved=JSON.parse(process.argv[1]); const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { if(await redis.set("lyrashield:scan-admission:stopped",saved.admissionStopValue,"NX")!=="OK") throw new Error("Admission already owned; no override"); console.log("ADMISSION_STOP_RECEIPT_BASE64="+Buffer.from(saved.admissionStopValue).toString("base64")); console.log("ADMISSION_STOP_OWNER="+saved.owner); } finally { await redis.quit(); }' "$saved"
  persist_phase claimed
  ;;
stop)
  assert_receipt
  if ! systemctl is-active --quiet "$service"; then
    assert_stopped
    assert_empty
    echo 'WEBHOOK_WRITERS_STOPPED'
    exit 0
  fi
  assert_running_environment
  assert_empty
  assert_tracks_terminal
  assert_legacy_schedule_drained
  systemctl disable --now "$timer"
  systemctl stop lyrashield-worker-egress-refresh.service
  systemctl disable --now "$service"
  assert_stopped
  [ ! -L "$stop_receipt" ]
  [ "$(stat -c '%u:%a' "$stop_receipt")" = 0:600 ]
  [ "$(stat -c '%Y' "$stop_receipt")" -ge "$(stat -c '%Y' "$receipt")" ]
  stopped=$(cat "$stop_receipt")
  oneshot 'const [saved,stopped]=process.argv.slice(1); const receipt=JSON.parse(saved); const proof=JSON.parse(stopped); if((receipt.previousWorkerImage!==proof.imageReference && receipt.candidateWorkerImage!==proof.imageReference && receipt.previousCandidateWorkerImage!==proof.imageReference) || receipt.databaseUrlSha256!==proof.databaseUrlSha256 || receipt.databaseSystemUrlSha256!==proof.databaseSystemUrlSha256 || receipt.redisUrlSha256!==proof.redisUrlSha256) throw new Error("Stop receipt image mismatch");' "$saved" "$stopped"
  persist_phase writers-stopped
  echo 'WEBHOOK_WRITERS_STOPPED'
  ;;
verify)
  assert_receipt
  assert_stopped
  assert_tracks_terminal
  assert_empty
  assert_legacy_schedule_drained
  echo 'WEBHOOK_QUIESCENCE_VERIFIED'
  ;;
resume)
  assert_running_environment
  assert_receipt
  # The local workflow has already verified every active app/scanner identity.
  # Independently require the exact new worker identity and protocol here.
  systemctl is-active --quiet "$service"
  docker exec -w /app/apps/worker "$container" node --import tsx --input-type=module -e 'const [revision]=process.argv.slice(1); const billing=await import("@lyrashield/billing"); if(process.env.LYRASHIELD_PRODUCT_REVISION!==revision || billing.WEBHOOK_TRACK_CLAIM_PROTOCOL!=="durable-claims/2") throw new Error("Compatible worker required before resume");' "$revision"
  persist_phase resuming
  systemctl enable --now "$timer"
  oneshot 'const receipt=JSON.parse(process.argv[1]); const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { const deleted=await redis.eval("if redis.call(\"GET\",KEYS[1]) == ARGV[1] then return redis.call(\"DEL\",KEYS[1]) else return 0 end",1,"lyrashield:scan-admission:stopped",receipt.admissionStopValue); if(deleted!==1) throw new Error("Admission ownership lost; no override"); } finally { await redis.quit(); }' "$saved"
  persist_phase completed
  mv "$receipt" "$receipt_dir/webhook-claims-cutover-completed-${run_id}.json"
  echo 'WEBHOOK_CUTOVER_RESUMED'
  ;;
*) exit 1;;
esac
