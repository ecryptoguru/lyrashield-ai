#!/bin/sh
# shellcheck disable=SC2016
set -eu
# JavaScript dollar names are literal; they must not expand in the host shell.
phase=${1:?phase}
migration_identity=${5:-}
attempt=${6:?workflow run attempt}
expected_original_run=${7:-}
expected_original_source=${8:-}
expected_original_owner=${9:-}
recovery_run_id=${10:-}
recovery_attempt=${11:-}
recovery_source=${12:-}
finalizer_run_id=${13:-}
finalizer_attempt=${14:-}
finalizer_source=${15:-}
prepared_worker_image=${16:-}
prepared_web_image=${17:-}
revision=${2:?product revision}
owner=${3:?run owner}
run_id=${4:?run ID}
case "$revision" in *[!a-f0-9]*|'') exit 1;; esac
[ ${#revision} -eq 40 ] || exit 1
case "$run_id" in *[!0-9]*|'') exit 1;; esac
case "$owner" in "$run_id":*[!0-9:]*|*[!0-9:]*|'') exit 1;; esac
case "$owner" in "$run_id":*) ;; *) exit 1;; esac
case "$attempt" in *[!0-9]*|'') exit 1;; esac
[ "$attempt" -gt 0 ] || exit 1
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
  pull_policy=
  case "$phase" in
    postrelease-probe|complete-postrelease) pull_policy=--pull=never ;;
  esac
  # Same bounded environment as promotion; no socket or scan files mounted.
  # shellcheck disable=SC2086
  docker run ${pull_policy:+$pull_policy} --rm --network bridge --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
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
  oneshot 'const strict=process.argv[1]==="strict"; const {getSystemPrisma}=await import("@lyrashield/db"); const prisma=getSystemPrisma(); try { const [schema]=await prisma.$queryRaw`SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=${"WebhookEventTrack"} AND column_name IN (${"nextAttemptAtUtc"},${"leaseExpiresAtUtc"})`; if(schema.count!==0&&schema.count!==2) throw new Error("Partial webhook UTC schema; inspect migration state"); if(schema.count===0||strict){const [legacy]=await prisma.$queryRaw`SELECT count(*)::integer AS count FROM "WebhookEventTrack" WHERE "nextAttemptAt" IS NOT NULL OR "leaseExpiresAt" IS NOT NULL`; if(legacy.count!==0) throw new Error("Legacy webhook scheduling values remain; drain existing work before the first UTC migration");} } finally { await prisma.$disconnect(); }' "${1:-ordinary}"
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
assert_recovery_stopped() {
  state=$(systemctl is-active "$service" || true)
  case "$state" in inactive|failed) ;; *) exit 1 ;; esac
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
validate_recovery_context() {
  : "${expected_original_run:?}" "${expected_original_source:?}" "${expected_original_owner:?}"
  : "${recovery_run_id:?}" "${recovery_attempt:?}" "${recovery_source:?}"
  case "$expected_original_run" in ''|*[!0-9]*) exit 1 ;; esac
  [ "${#expected_original_run}" -le 20 ] || exit 1
  case "$expected_original_source" in ''|*[!a-f0-9]*) exit 1 ;; esac
  [ "${#expected_original_source}" -eq 40 ] || exit 1
  case "$expected_original_owner" in *[!0-9:]*) exit 1 ;; esac
  case "$expected_original_owner" in "$expected_original_run":*) ;; *) exit 1 ;; esac
  case "$recovery_run_id" in ''|*[!0-9]*) exit 1 ;; esac
  [ "$recovery_run_id" = "$run_id" ] || exit 1
  case "$recovery_attempt" in ''|*[!0-9]*) exit 1 ;; esac
  [ "$recovery_attempt" = "$attempt" ] || exit 1
  case "$recovery_source" in ''|*[!a-f0-9]*) exit 1 ;; esac
  [ "${#recovery_source}" -eq 40 ] || exit 1
  [ "$recovery_source" = "$revision" ] || exit 1
  [ "$run_id" != "$expected_original_run" ] || exit 1
}
validate_postrelease_finalization_context() {
  validate_recovery_context
  case "$finalizer_run_id" in ''|*[!0-9]*) exit 1 ;; esac
  [ "${#finalizer_run_id}" -le 20 ] || exit 1
  [ "$finalizer_run_id" != "$expected_original_run" ] || exit 1
  [ "$finalizer_run_id" != "$recovery_run_id" ] || exit 1
  case "$finalizer_attempt" in ''|*[!0-9]*) exit 1 ;; esac
  [ "$finalizer_attempt" -gt 0 ] || exit 1
  case "$finalizer_source" in *[!a-f0-9]*|'') exit 1 ;; esac
  [ "${#finalizer_source}" -eq 40 ] || exit 1
  case "$prepared_worker_image" in ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:*) ;; *) exit 1 ;; esac
  digest=${prepared_worker_image##*@sha256:}
  case "$digest" in *[!a-f0-9]*|'') exit 1 ;; esac
  [ "${#digest}" -eq 64 ] || exit 1
  case "$prepared_web_image" in ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:*) ;; *) exit 1 ;; esac
  digest=${prepared_web_image##*@sha256:}
  case "$digest" in *[!a-f0-9]*|'') exit 1 ;; esac
  [ "${#digest}" -eq 64 ] || exit 1
}
load_recovery_receipt() {
  validate_recovery_context
  recovery_archive_only=0
  [ ! -L "$receipt" ] || exit 1
  if [ ! -e "$receipt" ] && [ "${1:-}" = allow-completed ]; then
    receipt="$receipt_dir/webhook-claims-cutover-completed-${expected_original_run}.json"
    recovery_archive_only=1
  fi
  [ -f "$receipt" ] && [ ! -L "$receipt" ] && [ "$(stat -c '%u:%a' "$receipt")" = 0:600 ] || exit 1
  saved=$(cat "$receipt")
}
assert_recovery_identity() {
  mode=$1
  oneshot '
const {createHash}=await import("node:crypto");
const {default:Redis}=await import("ioredis");
const [raw,mode,ownerRun,ownerSource,owner,recoveryRun,recoveryAttempt,recoverySource]=process.argv.slice(1);
const receipt=JSON.parse(raw);
const match=/^([0-9]+):([1-9][0-9]*)$/.exec(receipt.owner??"");
const stop=JSON.parse(receipt.admissionStopValue??"null");
const attempts=receipt.attempts;
const last=receipt.lastAttempt;
const hash=value=>createHash("sha256").update(value??"").digest("hex");
if(!match||receipt.runId!==ownerRun||match[1]!==ownerRun||receipt.owner!==owner||receipt.productRevision!==ownerSource||!/^([a-f0-9]{40})$/.test(ownerSource)||(!["claimed","writers-stopped"].includes(receipt.phase)&&receipt.phase!=="completed")||stop?.operator!=="github-actions"||stop.reason!=="webhook-claims-cutover"||stop.owner!==owner||stop.runId!==ownerRun||stop.productRevision!==ownerSource||!Array.isArray(attempts)||attempts.length===0||!Number.isSafeInteger(last)||!attempts.every((v,i)=>Number.isSafeInteger(v)&&v>0&&v<=last&&(i===0||v>attempts[i-1]))||new Set(attempts).size!==attempts.length||attempts[0]!==Number(match[2])||attempts.at(-1)!==last) throw new Error("Original held cutover receipt identity invalid");
for(const [key,env] of [["databaseUrlSha256","DATABASE_URL"],["databaseSystemUrlSha256","DATABASE_SYSTEM_URL"],["redisUrlSha256","REDIS_URL"]]) if(receipt[key]!==hash(process.env[env])) throw new Error("Original cutover connection identity changed");
const releases=receipt.recoveryReleases??[];
if(!Array.isArray(releases)||releases.length>8) throw new Error("Invalid recovery release history");
const release=releases.at(-1);
const sameRecovery=release&&release.runId===recoveryRun&&release.attempt===Number(recoveryAttempt)&&release.sourceRevision===recoverySource;
const completed=receipt.recoveryCompleted;
const sameCompletion=completed&&completed.runId===recoveryRun&&completed.attempt===Number(recoveryAttempt)&&completed.sourceRevision===recoverySource&&completed.engineRevision===release?.engineRevision&&completed.workerImage===release?.workerImage&&completed.protocol==="durable-claims/2";
const completedAllowed=["completed","hold","release"].includes(mode);
if(receipt.phase==="completed"&&(!completedAllowed||release?.status!=="released"||!sameRecovery||!sameCompletion)) throw new Error("Completed recovery receipt identity mismatch");
if(receipt.phase!=="completed"&&!( ["claimed","writers-stopped"].includes(receipt.phase))) throw new Error("Original held cutover receipt identity invalid");
if(receipt.phase==="completed"&&mode==="held") throw new Error("Completed recovery cannot re-enter held maintenance");
const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1});
try {
 const value=await redis.get("lyrashield:scan-admission:stopped");
 if(mode==="held"&&value!==receipt.admissionStopValue) throw new Error("Original admission stop changed");
 if(mode==="release"&&value!==receipt.admissionStopValue&&!(value===null&&sameRecovery&&["release-intent","released"].includes(release.status))) throw new Error("Original admission stop changed");
 if(mode==="hold"&&value!==receipt.admissionStopValue&&!(value===null&&sameRecovery&&["release-intent","released"].includes(release.status))) throw new Error("Original admission stop changed");
 if(mode==="completed"&&value!==null) throw new Error("Completed recovery still has an admission stop");
 console.log(value===null?"WITHOUT_ADMISSION_STOP":"ADMISSION_HELD");
} finally { await redis.quit(); }
' "$saved" "$mode" "$expected_original_run" "$expected_original_source" "$expected_original_owner" "$run_id" "$attempt" "$recovery_source"
}
write_recovery_receipt() {
  saved=$1
  umask 077
  temporary=$(mktemp "$receipt_dir/webhook-recovery.XXXXXX")
  printf '%s\n' "$saved" > "$temporary"
  chmod 600 "$temporary"
  chown root:root "$temporary"
  sync -f "$temporary"
  mv "$temporary" "$receipt"
  sync -f "$receipt_dir"
}
verify_running_recovery_candidate() {
  systemctl is-active --quiet "$service"
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" = healthy ] || exit 1
  [ "$(docker inspect --format '{{.Config.Image}}' "$container")" = "$image" ] || exit 1
  engine=$(docker image inspect --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}' "$image")
  [ "$(docker exec "$container" printenv LYRASHIELD_PRODUCT_REVISION)" = "$revision" ] || exit 1
  [ "$(docker exec "$container" printenv LYRASHIELD_ENGINE_REVISION)" = "$engine" ] || exit 1
  [ "$(docker exec "$container" printenv LYRASHIELD_WORKER_IMAGE_DIGEST)" = "${image##*@}" ] || exit 1
  live_hashes=$(docker exec "$container" node --input-type=module -e 'const {createHash}=await import("node:crypto"); const hash=value=>createHash("sha256").update(value??"").digest("hex"); console.log(JSON.stringify({databaseUrlSha256:hash(process.env.DATABASE_URL),databaseSystemUrlSha256:hash(process.env.DATABASE_SYSTEM_URL),redisUrlSha256:hash(process.env.REDIS_URL)}));')
  oneshot 'const billing=await import("@lyrashield/billing"); const db=await import("@lyrashield/db"); const {assertWebhookRecoveryCandidate,assertCompletedWebhookRecoveryReceipt,assertWebhookCutoverWorkerIdentity}=await import("file:///opt/lyrashield-worker-host/webhook-cutover-recovery.mjs"); const {assertFullyMigratedWebhookSchema,assertRuntimeRoleLeastPrivilege}=await import("file:///opt/lyrashield-worker-host/webhook-cutover-schema.mjs"); const [raw,ownerRun,ownerSource,owner,recoveryRun,recoveryAttempt,recoverySource,engine,image,live]=process.argv.slice(1); const receipt=JSON.parse(raw); const expected={ownerRunId:ownerRun,ownerSourceSha:ownerSource,owner,recoveryRunId:recoveryRun,recoveryAttempt:Number(recoveryAttempt),sourceRevision:recoverySource,engineRevision:engine,workerImage:image}; if(receipt.phase==="completed") assertCompletedWebhookRecoveryReceipt(receipt,expected); else assertWebhookRecoveryCandidate(receipt,expected); const actual=JSON.parse(live); for(const [key,value] of Object.entries(actual)) if(receipt[key]!==value) throw new Error("Running worker connection identity changed"); assertWebhookCutoverWorkerIdentity({receipt,workerImage:image,productRevision:process.env.LYRASHIELD_PRODUCT_REVISION,engineRevision:process.env.LYRASHIELD_ENGINE_REVISION,workerDigest:process.env.LYRASHIELD_WORKER_IMAGE_DIGEST,protocol:billing.WEBHOOK_TRACK_CLAIM_PROTOCOL,environment:process.env}); const system=db.getSystemPrisma(); try { await assertRuntimeRoleLeastPrivilege(db.prisma,process.env.DATABASE_URL); await assertFullyMigratedWebhookSchema(system,billing.WEBHOOK_TRACK_CLAIM_PROTOCOL); console.log("WEBHOOK_RECOVERY_RUNTIME_VERIFIED"); } finally { await Promise.allSettled([db.prisma.$disconnect(),system.$disconnect()]); }' "$saved" "$expected_original_run" "$expected_original_source" "$expected_original_owner" "$run_id" "$attempt" "$revision" "$engine" "$image" "$live_hashes" | grep -Fx 'WEBHOOK_RECOVERY_RUNTIME_VERIFIED' >/dev/null
}
record_recovery_release() {
  requested_state=$1
  release_image=$image
  release_engine=${engine:-}
  if [ -z "$release_engine" ]; then
    release_engine=$(docker image inspect --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}' "$release_image")
  fi
  case "$release_engine" in *[!a-f0-9]*|'') exit 1 ;; esac
  [ "${#release_engine}" -eq 40 ] || exit 1
  updated=$(oneshot 'const {assertWebhookRecoveryCandidate}=await import("file:///opt/lyrashield-worker-host/webhook-cutover-recovery.mjs"); const [raw,ownerRun,ownerSource,owner,recoveryRun,attempt,source,engine,image,state]=process.argv.slice(1); const receipt=JSON.parse(raw); const expected={ownerRunId:ownerRun,ownerSourceSha:ownerSource,owner,recoveryRunId:recoveryRun,recoveryAttempt:Number(attempt),sourceRevision:source,engineRevision:engine,workerImage:image}; assertWebhookRecoveryCandidate(receipt,expected); const list=receipt.recoveryReleases??[]; if(!Array.isArray(list)||list.length>8) throw new Error("Invalid recovery release history"); const identity={runId:recoveryRun,attempt:Number(attempt),sourceRevision:source,engineRevision:engine,workerImage:image,protocol:"durable-claims/2"}; let next=[...list]; const last=next.at(-1); const same=last&&last.runId===recoveryRun&&last.attempt===Number(attempt); if(same&&Object.entries(identity).some(([key,value])=>last[key]!==value)) throw new Error("Recovery release identity changed"); if(state==="release-intent"){ if(!same){if(next.length>=8)throw new Error("Recovery release history is full");next.push({...identity,status:"release-intent",startedAt:new Date().toISOString()});} else if(last.status==="released"){} else if(last.status!=="release-intent") throw new Error("Invalid recovery release state"); } else if(state==="released"){ if(!same||! ["release-intent","released"].includes(last.status)) throw new Error("Recovery release intent is required"); if(last.status!=="released") next[next.length-1]={...last,status:"released",releasedAt:new Date().toISOString()}; } else throw new Error("Invalid recovery release state"); const nextReceipt={...receipt,recoveryReleases:next}; for(const key of ["owner","runId","productRevision","admissionStopValue","attempts","lastAttempt","databaseUrlSha256","databaseSystemUrlSha256","redisUrlSha256"]) if(JSON.stringify(nextReceipt[key])!==JSON.stringify(receipt[key])) throw new Error("Recovery changed original receipt identity"); console.log(JSON.stringify(nextReceipt));' "$saved" "$expected_original_run" "$expected_original_source" "$expected_original_owner" "$run_id" "$attempt" "$recovery_source" "$release_engine" "$release_image" "$requested_state")
  write_recovery_receipt "$updated"
}
verify_recovery_finalization_audit() {
  finalization_audit=$(oneshot 'const [raw,ownerRun,ownerSource,owner,recoveryRun,recoveryAttempt,recoverySource,engine,workerImage,webImage]=process.argv.slice(1); const receipt=JSON.parse(raw); const audit=receipt.recoveryFinalization; if(audit===undefined){console.log("ABSENT");process.exit(0)}; const expected={originalRunId:ownerRun,originalOwner:owner,originalSourceSha:ownerSource,recoveryRunId:recoveryRun,recoveryAttempt:Number(recoveryAttempt),recoverySourceSha:recoverySource,engineRevision:engine,preparedWorkerImage:workerImage,preparedWebImage:webImage}; const keys=[...Object.keys(expected),"runId","attempt","operationsSourceRevision","completedAt"].sort(); const validRun=typeof audit?.runId==="string"&&/^[1-9][0-9]{0,19}$/.test(audit.runId); const validAttempt=Number.isSafeInteger(audit?.attempt)&&audit.attempt>0; const validSource=typeof audit?.operationsSourceRevision==="string"&&/^[a-f0-9]{40}$/.test(audit.operationsSourceRevision); const validTime=typeof audit?.completedAt==="string"&&Number.isFinite(Date.parse(audit.completedAt))&&new Date(audit.completedAt).toISOString()===audit.completedAt; if(!audit||typeof audit!=="object"||Array.isArray(audit)||JSON.stringify(Object.keys(audit).sort())!==JSON.stringify(keys)||Object.entries(expected).some(([key,value])=>audit[key]!==value)||!validRun||!validAttempt||!validSource||!validTime) throw new Error("Post-release finalization audit does not match the exact owner and prepared images"); console.log(JSON.stringify(audit));' "$saved" "$expected_original_run" "$expected_original_source" "$expected_original_owner" "$recovery_run_id" "$recovery_attempt" "$recovery_source" "$engine" "$prepared_worker_image" "$prepared_web_image")
}
emit_recovery_finalization_audit() {
  verify_recovery_finalization_audit
  if [ "$finalization_audit" = ABSENT ]; then
    echo WEBHOOK_POST_RELEASE_AUDIT_STATE=absent
    return
  fi
  oneshot 'const audit=JSON.parse(process.argv[1]); console.log("WEBHOOK_POST_RELEASE_AUDIT_STATE=present"); console.log("WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_RUN_ID="+audit.runId); console.log("WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_ATTEMPT="+audit.attempt); console.log("WEBHOOK_POST_RELEASE_AUDIT_FINALIZER_SOURCE_SHA="+audit.operationsSourceRevision);' "$finalization_audit"
}
record_recovery_finalization_audit() {
  verify_recovery_finalization_audit
  if [ "$finalization_audit" = ABSENT ]; then
    updated=$(oneshot 'const [raw,ownerRun,ownerSource,owner,recoveryRun,recoveryAttempt,recoverySource,finalizerRun,finalizerAttempt,finalizerSource,engine,workerImage,webImage]=process.argv.slice(1); const receipt=JSON.parse(raw); if(receipt.recoveryFinalization!==undefined) throw new Error("Finalization audit was concurrently written"); const audit={runId:finalizerRun,attempt:Number(finalizerAttempt),operationsSourceRevision:finalizerSource,originalRunId:ownerRun,originalOwner:owner,originalSourceSha:ownerSource,recoveryRunId:recoveryRun,recoveryAttempt:Number(recoveryAttempt),recoverySourceSha:recoverySource,engineRevision:engine,preparedWorkerImage:workerImage,preparedWebImage:webImage,completedAt:new Date().toISOString()}; const next={...receipt,recoveryFinalization:audit}; for(const key of ["owner","runId","productRevision","admissionStopValue","attempts","lastAttempt","databaseUrlSha256","databaseSystemUrlSha256","redisUrlSha256"]) if(JSON.stringify(next[key])!==JSON.stringify(receipt[key])) throw new Error("Finalization audit changed original receipt identity"); console.log(JSON.stringify(next));' "$saved" "$expected_original_run" "$expected_original_source" "$expected_original_owner" "$recovery_run_id" "$recovery_attempt" "$recovery_source" "$finalizer_run_id" "$finalizer_attempt" "$finalizer_source" "$engine" "$prepared_worker_image" "$prepared_web_image")
    write_recovery_receipt "$updated"
    verify_recovery_finalization_audit
  fi
}
archive_completed_recovery() {
  completed_receipt="$receipt_dir/webhook-claims-cutover-completed-${expected_original_run}.json"
  completed=$(oneshot '
const [raw,ownerRun,ownerSource,owner,recoveryRun,attempt,source,engine,image]=process.argv.slice(1);
const receipt=JSON.parse(raw);
const list=receipt.recoveryReleases??[];
const last=list.at(-1);
const candidates=receipt.recoveryCandidates??[];
const candidate=candidates.at(-1);
const stop=JSON.parse(receipt.admissionStopValue);
if(receipt.owner!==owner||receipt.runId!==ownerRun||receipt.productRevision!==ownerSource||!["claimed","writers-stopped"].includes(receipt.phase)||stop.owner!==owner||stop.runId!==ownerRun||stop.productRevision!==ownerSource||!last||last.runId!==recoveryRun||last.attempt!==Number(attempt)||last.sourceRevision!==source||last.engineRevision!==engine||last.workerImage!==image||last.protocol!=="durable-claims/2"||last.status!=="released"||!candidate||candidate.recoveryRunId!==recoveryRun||candidate.recoveryAttempt!==Number(attempt)||candidate.sourceRevision!==source||candidate.engineRevision!==engine||candidate.workerImage!==image||candidate.protocol!=="durable-claims/2") throw new Error("Recovery release completion identity mismatch");
const stable={owner:receipt.owner,runId:receipt.runId,productRevision:receipt.productRevision,admissionStopValue:receipt.admissionStopValue,attempts:receipt.attempts,lastAttempt:receipt.lastAttempt,databaseUrlSha256:receipt.databaseUrlSha256,databaseSystemUrlSha256:receipt.databaseSystemUrlSha256,redisUrlSha256:receipt.redisUrlSha256};
const next={...receipt,phase:"completed",recoveryCompleted:{...last,completedAt:new Date().toISOString()}};
for(const [key,value] of Object.entries(stable)) if(JSON.stringify(next[key])!==JSON.stringify(value)) throw new Error("Recovery completion changed original receipt identity");
console.log(JSON.stringify(next));' "$saved" "$expected_original_run" "$expected_original_source" "$expected_original_owner" "$run_id" "$attempt" "$recovery_source" "$engine" "$image")
  if [ -e "$completed_receipt" ] || [ -L "$completed_receipt" ]; then
    [ -f "$completed_receipt" ] && [ ! -L "$completed_receipt" ] && [ "$(stat -c '%u:%a' "$completed_receipt")" = 0:600 ] || exit 1
    archived=$(cat "$completed_receipt")
    oneshot '
const {assertCompletedWebhookRecoveryReceipt}=await import("file:///opt/lyrashield-worker-host/webhook-cutover-recovery.mjs");
const [archived,active,ownerRun,ownerSource,owner,recoveryRun,attempt,source,engine,image]=process.argv.slice(1);
const completed=JSON.parse(archived);
const current=JSON.parse(active);
const expected={ownerRunId:ownerRun,ownerSourceSha:ownerSource,owner,recoveryRunId:recoveryRun,recoveryAttempt:Number(attempt),sourceRevision:source,engineRevision:engine,workerImage:image};
assertCompletedWebhookRecoveryReceipt(completed,expected);
const stable=receipt=>({owner:receipt.owner,runId:receipt.runId,productRevision:receipt.productRevision,admissionStopValue:receipt.admissionStopValue,attempts:receipt.attempts,lastAttempt:receipt.lastAttempt,databaseUrlSha256:receipt.databaseUrlSha256,databaseSystemUrlSha256:receipt.databaseSystemUrlSha256,redisUrlSha256:receipt.redisUrlSha256,recoveryCandidates:receipt.recoveryCandidates,recoveryReleases:receipt.recoveryReleases,recoveryFinalization:receipt.recoveryFinalization});
const archivedStable=stable(completed);
for(const [key,value] of Object.entries(stable(current))) if(JSON.stringify(value)!==JSON.stringify(archivedStable[key])) throw new Error("Active and archived recovery receipts differ");
if(!["claimed","writers-stopped"].includes(current.phase)) throw new Error("Active recovery receipt phase is invalid");' "$archived" "$saved" "$expected_original_run" "$expected_original_source" "$expected_original_owner" "$run_id" "$attempt" "$recovery_source" "$engine" "$image"
  else
    umask 077
    temporary=$(mktemp "$receipt_dir/webhook-complete.XXXXXX")
    printf '%s\n' "$completed" > "$temporary"
    chmod 600 "$temporary"
    chown root:root "$temporary"
    sync -f "$temporary"
    if ! ln "$temporary" "$completed_receipt" 2>/dev/null; then
      rm -f "$temporary"
      exit 1
    fi
    rm -f "$temporary"
  fi
  rm -f "$receipt"
  sync -f "$receipt_dir"
  echo WEBHOOK_RECOVERY_COMPLETE
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
recovery-probe-new-run)
  validate_recovery_context
  if [ ! -e "$receipt" ] && [ ! -L "$receipt" ]; then
    oneshot 'const {default:Redis}=await import("ioredis"); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { if(await redis.get("lyrashield:scan-admission:stopped")!==null) throw new Error("Admission stop exists without an owned cutover receipt"); } finally { await redis.quit(); }'
    echo 'WEBHOOK_RECOVERY_RECEIPT_ABSENT'
    exit 0
  fi
  [ ! -L "$receipt" ] && [ "$(stat -c '%u:%a' "$receipt")" = 0:600 ] || exit 1
  saved=$(cat "$receipt")
  recovery_info=$(oneshot '
const {createHash}=await import("node:crypto");
const {default:Redis}=await import("ioredis");
const [saved,currentRun,currentSource,currentAttempt,expectedRun,expectedSource,expectedOwner]=process.argv.slice(1);
const receipt=JSON.parse(saved);
const owner=/^([0-9]+):([1-9][0-9]*)$/.exec(receipt.owner??"");
const stop=JSON.parse(receipt.admissionStopValue??"null");
const attempts=receipt.attempts;
const last=receipt.lastAttempt;
const hash=v=>createHash("sha256").update(v??"").digest("hex");
if(!owner||receipt.runId!==owner[1]||receipt.runId!==expectedRun||!/^([a-f0-9]{40})$/.test(receipt.productRevision??"")||receipt.productRevision!==expectedSource||receipt.owner!==expectedOwner||receipt.runId===currentRun||!/^([0-9]{1,20})$/.test(currentRun)||!/^([a-f0-9]{40})$/.test(currentSource)||!Number.isSafeInteger(Number(currentAttempt))||Number(currentAttempt)<1||!["claimed","writers-stopped"].includes(receipt.phase)||stop?.operator!=="github-actions"||stop.reason!=="webhook-claims-cutover"||stop.owner!==receipt.owner||stop.runId!==receipt.runId||stop.productRevision!==receipt.productRevision||!Array.isArray(attempts)||attempts.length===0||!Number.isSafeInteger(last)||!attempts.every((v,i)=>Number.isSafeInteger(v)&&v>0&&v<=last&&(i===0||v>attempts[i-1]))||new Set(attempts).size!==attempts.length||attempts[0]!==Number(owner[2])||attempts.at(-1)!==last) throw new Error("Original held receipt identity invalid");
for(const key of ["databaseUrlSha256","databaseSystemUrlSha256","redisUrlSha256"]) if(receipt[key]!==hash(process.env[key==="databaseUrlSha256"?"DATABASE_URL":key==="databaseSystemUrlSha256"?"DATABASE_SYSTEM_URL":"REDIS_URL"])) throw new Error("Original connection identity changed");
const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1});
try { if(await redis.get("lyrashield:scan-admission:stopped")!==receipt.admissionStopValue) throw new Error("Original admission stop changed"); } finally { await redis.quit(); }
const candidates=receipt.recoveryCandidates??[];
if(!Array.isArray(candidates)||candidates.length>8||candidates.some((c,i)=>!c||!/^([0-9]{1,20})$/.test(c.recoveryRunId??"")||!Number.isSafeInteger(c.recoveryAttempt)||c.recoveryAttempt<1||!/^([a-f0-9]{40})$/.test(c.sourceRevision??"")||!/^([a-f0-9]{40})$/.test(c.engineRevision??"")||!/^.+@sha256:[a-f0-9]{64}$/.test(c.workerImage??"")||c.protocol!=="durable-claims/2"||c.recoveryRunId===receipt.runId||(i>0&&c.recoveryRunId===candidates[i-1].recoveryRunId&&c.recoveryAttempt<=candidates[i-1].recoveryAttempt))) throw new Error("Recovery candidate history invalid");
console.log("WEBHOOK_NEW_RUN_RECOVERY_VERIFIED");
console.log("WEBHOOK_RECOVERY_OWNER="+receipt.owner);
console.log("WEBHOOK_RECOVERY_OWNER_RUN_ID="+receipt.runId);
console.log("WEBHOOK_RECOVERY_OWNER_SOURCE_SHA="+receipt.productRevision);
' "$saved" "$run_id" "$revision" "$attempt" "$expected_original_run" "$expected_original_source" "$expected_original_owner")
  assert_recovery_stopped
  assert_empty
  assert_tracks_terminal
  assert_legacy_schedule_drained strict
  printf '%s\n' "$recovery_info"
  ;;
recovery-hold-verify)
  load_recovery_receipt allow-completed
  hold_state=$(assert_recovery_identity hold)
  case "$hold_state" in ADMISSION_HELD|WITHOUT_ADMISSION_STOP) ;; *) exit 1 ;; esac
  if [ "$hold_state" = ADMISSION_HELD ]; then
    echo WEBHOOK_RECOVERY_HOLD_ADMISSION_HELD
  else
    echo WEBHOOK_RECOVERY_HOLD_WITHOUT_ADMISSION_STOP
  fi
  ;;
recovery-hold)
  load_recovery_receipt allow-completed
  hold_state=$(assert_recovery_identity hold)
  case "$hold_state" in ADMISSION_HELD|WITHOUT_ADMISSION_STOP) ;; *) exit 1 ;; esac
  if [ "$hold_state" = ADMISSION_HELD ]; then
    systemctl disable --now "$timer"
    systemctl stop lyrashield-worker-egress-refresh.service
    systemctl disable --now "$service"
    assert_recovery_stopped
    echo WEBHOOK_RECOVERY_HOLD_ADMISSION_HELD
  else
    # The exact original stop was already removed. Keep the verified recovery
    # worker intact; the caller closes and reads back app/scanner revisions.
    if [ "$recovery_archive_only" -eq 0 ]; then record_recovery_release released; fi
    echo WEBHOOK_RECOVERY_HOLD_WITHOUT_ADMISSION_STOP
  fi
  ;;
postrelease-probe)
  validate_postrelease_finalization_context
  load_recovery_receipt allow-completed
  engine=$(docker image inspect --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}' "$image")
  case "$engine" in *[!a-f0-9]*|'') exit 1 ;; esac
  [ "${#engine}" -eq 40 ] || exit 1
  [ "$prepared_worker_image" = "$image" ] || exit 1
  if [ "$recovery_archive_only" -eq 1 ]; then
    recovery_state=$(assert_recovery_identity completed)
    receipt_state=completed
  else
    recovery_state=$(assert_recovery_identity release)
    [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
    receipt_state=$(oneshot 'const [raw,run,attempt,source,engine,image]=process.argv.slice(1); const receipt=JSON.parse(raw); const release=receipt.recoveryReleases?.at(-1); if(!release||!["release-intent","released"].includes(release.status)||release.runId!==run||release.attempt!==Number(attempt)||release.sourceRevision!==source||release.engineRevision!==engine||release.workerImage!==image||release.protocol!=="durable-claims/2") throw new Error("Post-release receipt identity is invalid"); console.log(release.status);' "$saved" "$recovery_run_id" "$recovery_attempt" "$recovery_source" "$engine" "$image")
  fi
  [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
  verify_running_recovery_candidate
  systemctl is-active --quiet "$timer"
  [ "$(systemctl is-enabled "$timer" || true)" = enabled ] || exit 1
  emit_recovery_finalization_audit
  printf '%s\n' \
    WEBHOOK_POST_RELEASE_FINALIZATION_VERIFIED \
    "WEBHOOK_POST_RELEASE_ORIGINAL_OWNER=$expected_original_owner" \
    "WEBHOOK_POST_RELEASE_RECOVERY_RUN_ID=$recovery_run_id" \
    "WEBHOOK_POST_RELEASE_RECOVERY_ATTEMPT=$recovery_attempt" \
    "WEBHOOK_POST_RELEASE_RECOVERY_SOURCE_SHA=$recovery_source" \
    "WEBHOOK_POST_RELEASE_FINALIZER_RUN_ID=$finalizer_run_id" \
    "WEBHOOK_POST_RELEASE_FINALIZER_ATTEMPT=$finalizer_attempt" \
    "WEBHOOK_POST_RELEASE_FINALIZER_SOURCE_SHA=$finalizer_source" \
    "WEBHOOK_POST_RELEASE_WORKER_IMAGE=$image" \
    "WEBHOOK_POST_RELEASE_WEB_IMAGE=$prepared_web_image" \
    "WEBHOOK_POST_RELEASE_ENGINE_REVISION=$engine" \
    "WEBHOOK_POST_RELEASE_RECEIPT_STATE=$receipt_state"
  ;;
complete-postrelease)
  validate_postrelease_finalization_context
  load_recovery_receipt allow-completed
  engine=$(docker image inspect --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}' "$image")
  case "$engine" in *[!a-f0-9]*|'') exit 1 ;; esac
  [ "${#engine}" -eq 40 ] || exit 1
  [ "$prepared_worker_image" = "$image" ] || exit 1
  if [ "$recovery_archive_only" -eq 1 ]; then
    recovery_state=$(assert_recovery_identity completed)
    [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
    verify_running_recovery_candidate
    systemctl is-active --quiet "$timer"
    [ "$(systemctl is-enabled "$timer" || true)" = enabled ] || exit 1
    emit_recovery_finalization_audit
    echo WEBHOOK_RECOVERY_COMPLETE
    echo WEBHOOK_POST_RELEASE_FINALIZATION_COMPLETE
    exit 0
  fi
  recovery_state=$(assert_recovery_identity release)
  [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
  verify_running_recovery_candidate
  systemctl is-active --quiet "$timer"
  [ "$(systemctl is-enabled "$timer" || true)" = enabled ] || exit 1
  release_state=$(oneshot 'const [raw,run,attempt,source,engine,image]=process.argv.slice(1); const receipt=JSON.parse(raw); const release=receipt.recoveryReleases?.at(-1); if(!release||!["release-intent","released"].includes(release.status)||release.runId!==run||release.attempt!==Number(attempt)||release.sourceRevision!==source||release.engineRevision!==engine||release.workerImage!==image||release.protocol!=="durable-claims/2") throw new Error("Post-release receipt identity is invalid"); console.log(release.status);' "$saved" "$recovery_run_id" "$recovery_attempt" "$recovery_source" "$engine" "$image")
  if [ "$release_state" = release-intent ]; then
    record_recovery_release released
  fi
  recovery_state=$(assert_recovery_identity release)
  [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
  record_recovery_finalization_audit
  archive_completed_recovery
  emit_recovery_finalization_audit
  echo WEBHOOK_POST_RELEASE_FINALIZATION_COMPLETE
  ;;
resume-recovery)
  load_recovery_receipt
  recovery_state=$(assert_recovery_identity release)
  if [ "$recovery_state" = WITHOUT_ADMISSION_STOP ]; then
    # A failed Redis EVAL reply can hide a successful compare-delete. Reconcile
    # only the exact durable intent from this invocation. Admissions may have
    # reopened after the delete, so do not require queues to remain empty.
    verify_running_recovery_candidate
    systemctl is-active --quiet "$timer"
    [ "$(systemctl is-enabled "$timer" || true)" = enabled ] || exit 1
    recovery_state=$(assert_recovery_identity release)
    [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
    record_recovery_release released
    recovery_state=$(assert_recovery_identity release)
    [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
    echo WEBHOOK_CUTOVER_ADMISSION_RELEASED
    exit 0
  fi
  [ "$recovery_state" = ADMISSION_HELD ] || exit 1
  verify_running_recovery_candidate
  assert_empty
  assert_tracks_terminal
  assert_legacy_schedule_drained strict
  recovery_state=$(assert_recovery_identity held)
  [ "$recovery_state" = ADMISSION_HELD ] || exit 1
  systemctl enable --now "$timer"
  systemctl is-active --quiet "$timer"
  assert_empty
  assert_tracks_terminal
  assert_legacy_schedule_drained strict
  recovery_state=$(assert_recovery_identity held)
  [ "$recovery_state" = ADMISSION_HELD ] || exit 1
  record_recovery_release release-intent
  if ! removed=$(oneshot 'const {default:Redis}=await import("ioredis"); const receipt=JSON.parse(process.argv[1]); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { const removed=await redis.eval(`if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end`,1,"lyrashield:scan-admission:stopped",receipt.admissionStopValue); console.log(removed); } finally { await redis.quit(); }' "$saved" 2>/dev/null); then
    removed=UNKNOWN
  fi
  case "$removed" in 1|0|UNKNOWN) ;; *) exit 1 ;; esac
  release_readback=$(oneshot 'const {default:Redis}=await import("ioredis"); const receipt=JSON.parse(process.argv[1]); const redis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1}); try { const value=await redis.get("lyrashield:scan-admission:stopped"); console.log(value===null?"ABSENT":value===receipt.admissionStopValue?"HELD":"FOREIGN"); } finally { await redis.quit(); }' "$saved")
  [ "$release_readback" = ABSENT ] || exit 1
  recovery_state=$(assert_recovery_identity release)
  [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
  record_recovery_release released
  recovery_state=$(assert_recovery_identity release)
  [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
  echo WEBHOOK_CUTOVER_ADMISSION_RELEASED
  ;;
complete-recovery)
  load_recovery_receipt allow-completed
  if [ "$recovery_archive_only" -eq 1 ]; then
    recovery_state=$(assert_recovery_identity completed)
    [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
    verify_running_recovery_candidate
    recovery_state=$(assert_recovery_identity completed)
    [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
    echo WEBHOOK_RECOVERY_COMPLETE
    exit 0
  fi
  recovery_state=$(assert_recovery_identity release)
  [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
  verify_running_recovery_candidate
  recovery_state=$(assert_recovery_identity release)
  [ "$recovery_state" = WITHOUT_ADMISSION_STOP ] || exit 1
  archive_completed_recovery
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
