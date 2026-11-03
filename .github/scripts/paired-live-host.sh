#!/bin/sh
# Unwired protected VM entry point, transferred with its exact Git sources.
set -eu
phase=$1 argument=$2 dir=$3
case "$phase" in rpc|drain|continuity|relay|accounted|evidence|unused|worker|stopped|physical|stop|contain|stage-sandbox|clear|selector-absent|armed-selector) ;; *) exit 2 ;; esac
config=/etc/lyrashield/worker-runtime.conf
env_file=/etc/lyrashield/worker.env
pins=/run/lyrashield-egress-hosts
# Use the service's installed loader, including its deployed selector policy.
loader=/opt/lyrashield-worker-host/worker-env.sh
for file in "$loader" "$config" "$env_file"; do
  [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %u "$file")" = 0 ] || exit 1
  case "$(stat -c %a "$file")" in 400|440|444|500|550|555|600|640|644|700|740|744|750|754|755) ;; *) exit 1 ;; esac
done
# shellcheck disable=SC1090
. "$loader"
image=$(sed -n 's/^LYRASHIELD_WORKER_IMAGE=//p' "$config")
sandbox=$(sed -n 's/^LYRASHIELD_SANDBOX_IMAGE=//p' "$config")
printf '%s\n' "$image" | grep -Eq '^ghcr\.io/ecryptoguru/lyrashield-ai/lyrashield-worker@sha256:[a-f0-9]{64}$'
printf '%s\n' "$sandbox" | grep -Eq '^ghcr\.io/ecryptoguru/lyrashield-sandbox@sha256:[a-f0-9]{64}$'
sibling="$config.evidence-writer-canary"
command -v jq >/dev/null
exec 9>/run/lyrashield/paired-runtime-operation.lock
flock -n 9 || exit 1
active=lyrashield-worker.service
timer=lyrashield-worker-egress-refresh.timer
# This dedicated worker VM has no separate allowlist of trustworthy consumers.
# Enumerate ALL running IDs. A second or ambiguous container blocks the proof
# regardless of its name, tag, entrypoint, or image-ID-only launch.
census(){
  ids=$(docker ps --quiet --no-trunc) || return 1
  if [ -z "$ids" ]; then
    [ "$1" != running ] || return 1
    named=$(docker ps -a --filter 'name=^/lyrashield-worker$' --format '{{.Names}}') || return 1
    again=$(docker ps --quiet --no-trunc) || return 1
    [ -z "$named" ] && [ -z "$again" ]; return
  fi
  [ "$1" != stopped ] || return 1
  printf '%s\n' "$ids" | grep -Eq '^[a-f0-9]{64}$' || return 1
  canonical=$(docker inspect --type container lyrashield-worker --format '{{.Id}}')
  [ "$ids" = "$canonical" ] || return 1
  live_id=$(docker inspect "$canonical" --format '{{.Image}}')
  pinned_id=$(docker image inspect "$image" --format '{{.Id}}')
  [ -n "$pinned_id" ] && [ "$live_id" = "$pinned_id" ] || return 1
  [ "$(docker inspect "$canonical" --format '{{.Config.Image}}')" = "$image" ] || return 1
  [ "$(docker inspect "$canonical" --format '{{json .Config.Healthcheck.Test}}')" = '["CMD-SHELL","test -f /tmp/lyrashield-worker-ready"]' ] || return 1
  # Bind the actual service process launch arguments to the verified image.
  live_cmd=$(docker inspect "$canonical" --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}')
  image_cmd=$(docker image inspect "$image" --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}')
  [ -n "$image_cmd" ] && [ "$live_cmd" = "$image_cmd" ] || return 1
  # The production Dockerfile launches tsx apps/worker/src/index.ts. Inspect
  # only that argv marker inside the container, never its raw process list.
  docker exec lyrashield-worker node -e 'const a=require("node:fs").readFileSync("/proc/1/cmdline","utf8").split("\0");if(!a.some(x=>x==="apps/worker/src/index.ts"||x==="/app/apps/worker/src/index.ts"))process.exit(1)' || return 1
  verified=$(docker ps --quiet --no-trunc) || return 1
  [ "$verified" = "$canonical" ]
}
stopped(){
  census stopped || return 1
  for unit in "$active" "$timer"; do
    [ "$(systemctl is-active "$unit" 2>/dev/null || true)" = inactive ] &&
      [ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" = disabled ] || return 1
  done
  test "$(systemctl is-active lyrashield-worker-egress-refresh.service 2>/dev/null || true)" = inactive
  workers=$(docker ps -a --filter 'name=^/lyrashield-worker$' --format '{{.Names}}')
  test -z "$workers"
}
private_file(){
  [ -f "$sibling" ] && [ ! -L "$sibling" ] && [ "$(stat -c '%u:%h' "$sibling")" = "$(stat -c %u "$config"):1" ] || return 1
  case "$(stat -c '%a' "$sibling")" in 400|600) ;; *) return 1 ;; esac
  [ "$(wc -c < "$sibling")" -le 2084 ]
}
oneshot(){
  env_args=$(lyrashield_worker_env_args "$config" "$env_file")
  pin_args=$(awk 'NF!=3 || $1!~/^[A-Za-z0-9.-]+$/ || $2!~/^[0-9.]+$/ || $3!~/^[0-9]+$/ {exit 1} {print "--add-host "$1":"$2}' "$pins")
  [ -n "$pin_args" ]
  # Worker code needs the scoped database/Redis paths and no Docker socket.
  # shellcheck disable=SC2086
  timeout --kill-after=5s 50s docker run --rm --pull never --user 0 --read-only --network bridge --cap-drop ALL --security-opt no-new-privileges \
    --env-file "$env_file" $pin_args $env_args --env TMPDIR=/tmp --env "PAIRED_RUNTIME_DB_HASH=${db_hash:-}" --env "PAIRED_PHYSICAL_PROOF=${physical:-}" \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=32m --mount "type=bind,src=$dir/.github,dst=/paired/.github,readonly" --mount "type=bind,src=$dir/ops,dst=/paired/ops,readonly" \
    -w /app/apps/worker "$image" node --import tsx /paired/.github/scripts/paired-live-guest.mjs "$1" "$2"
}
check_startup_unit(){
  # Refuse unaccounted unit inputs that could redirect the next service start
  # to another loader/config/env file. Never print the environment.
  for property in Environment EnvironmentFiles PassEnvironment DropInPaths; do
    value=$(systemctl show "$active" --property="$property" --value) || return 1
    [ -z "$value" ] || return 1
  done
  command=$(systemctl show "$active" --property=ExecStart --value) || return 1
  case "$command" in *'path=/usr/local/libexec/lyrashield-run-worker ; argv[]=/usr/local/libexec/lyrashield-run-worker ;'*) ;; *) return 1 ;; esac
}
bind_runtime_db(){
  check_startup_unit || return 1
  policy=$(oneshot startup-policy e30=) || return 1
  db_hash=$(printf '%s' "$policy" | jq -er '.databaseUrlHash | select(test("^[a-f0-9]{64}$"))') || return 1
  running=$(docker ps --quiet --no-trunc) || return 1
  if [ -z "$running" ]; then stopped || return 1
  else census running || return 1
    docker exec lyrashield-worker node -e 'const v=process.env.DATABASE_URL; if(!v||require("node:crypto").createHash("sha256").update(v).digest("hex")!==process.argv[1])process.exit(1)' "$db_hash" || return 1
  fi
}
expected() { printf '%s' "$argument" | base64 -d | jq -er "$1"; }
guard(){ receipt=$(expected '.receipt'); input=$(jq -nc --arg r "$receipt" '["assert",$r]' | base64 -w0); [ "$(oneshot rpc "$input")" = 1 ]; }
physical_check(){ sh "$dir/.github/scripts/v26-execution-drain.sh"; }
case "$phase" in
  continuity)
    observed=$(oneshot continuity "$argument")
    workers=$(docker ps -a --filter 'name=^/lyrashield-worker$' --format '{{.Names}}')
    if [ -n "$workers" ]; then
      expected_db=$(printf '%s' "$observed"|jq -er .databaseUrlHash)
      expected_redis=$(printf '%s' "$observed"|jq -er .redisUrlHash)
      docker exec lyrashield-worker node -e 'const h=k=>require("node:crypto").createHash("sha256").update(process.env[k]).digest("hex");if(h("DATABASE_URL")!==process.argv[1]||h("REDIS_URL")!==process.argv[2])process.exit(1)' "$expected_db" "$expected_redis"
    else stopped; fi
    printf '%s' "$observed" ;;
  accounted|unused) bind_runtime_db; oneshot "$phase" "$argument" ;;
  rpc|relay|evidence) oneshot "$phase" "$argument" ;;
  drain) bind_runtime_db; physical=$(physical_check); [ "$physical" = V26_EXECUTION_DRAIN_VERIFIED ]; oneshot drain "$argument" ;;
  physical) [ "$(physical_check)" = V26_EXECUTION_DRAIN_VERIFIED ]; printf '"V26_EXECUTION_DRAIN_VERIFIED"' ;;
  stage-sandbox)
    guard; stopped
    expected_prior=$(expected '.priorWorkerDigest')
    [ "$image" = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@$expected_prior" ]
    digest=$(expected '.sandboxDigest'); engine=$(expected '.engineRevision')
    printf '%s\n' "$digest" | grep -Eq '^sha256:[a-f0-9]{64}$'
    printf '%s\n' "$engine" | grep -Eq '^[a-f0-9]{40}$'
    ref="ghcr.io/ecryptoguru/lyrashield-sandbox@$digest"
    case "$(docker info --format '{{.Architecture}}')" in x86_64|amd64) size=$(expected '.amd64Bytes') ;; aarch64|arm64) size=$(expected '.arm64Bytes') ;; *) exit 1 ;; esac
    case "$size" in ''|*[!0-9]*) exit 1 ;; esac
    [ "${#size}" -le 11 ] && [ "$size" -gt 0 ] && [ "$size" -le 53687091200 ] || exit 1
    root=$(docker info --format '{{.DockerRootDir}}'); [ -d "$root" ]
    available(){ df -P -B1 "$root" | awk 'NR==2 && $4~/^[0-9]+$/ {print $4}'; }
    # Preserve both old images and the space needed by the subsequent VM promotion.
    old_id=$(docker image inspect "$sandbox" --format '{{.Id}}'); [ -n "$old_id" ]
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
      [ "$(available)" -ge "$((size * 3 + 2147483648))" ]
      token=$(sed -n 's/^GHCR_TOKEN=//p' "$env_file")
      user=$(sed -n 's/^GHCR_USERNAME=//p' "$config")
      [ -n "$user" ] || user=$(sed -n 's/^GHCR_USERNAME=//p' "$env_file")
      [ -n "$token" ] || exit 1
      printf '%s\n' "$user" | grep -Eq '^[A-Za-z0-9_-]{1,80}$'
      DOCKER_CONFIG="$dir/registry"; export DOCKER_CONFIG; mkdir -m 0700 "$DOCKER_CONFIG"
      printf '%s' "$token" | timeout 30s docker login ghcr.io -u "$user" --password-stdin >/dev/null 2>&1
      unset token; guard; timeout --kill-after=10s 1200s docker pull "$ref" >/dev/null 2>&1
    fi
    guard; stopped
    refs=$(docker image inspect "$ref" --format '{{range .RepoDigests}}{{println .}}{{end}}'); printf '%s\n' "$refs" | grep -Fxq "$ref"
    [ "$(docker image inspect "$ref" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$engine" ]
    [ "$(docker image inspect "$ref" --format '{{.Size}}')" = "$size" ]
    [ "$(docker image inspect "$sandbox" --format '{{.Id}}')" = "$old_id" ] && [ "$(available)" -ge 2147483648 ] || exit 1
    printf 'true' ;;
  stop|contain) guard; census manageable; if [ "$phase" = stop ]; then [ "$image" = "ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@$(expected '.expectedDigest')" ]; fi; systemctl disable --now "$timer"; guard; systemctl stop lyrashield-worker-egress-refresh.service; guard; systemctl disable --now "$active"; stopped; [ "$(physical_check)" = V26_EXECUTION_DRAIN_VERIFIED ]; guard; printf 'true' ;;
  stopped) stopped; [ "$(physical_check)" = V26_EXECUTION_DRAIN_VERIFIED ]; jq -nc --arg image "$image" --arg sandbox "$sandbox" '{image:$image,sandbox:$sandbox}' ;;
  selector-absent) [ ! -e "$sibling" ] && [ ! -L "$sibling" ] || exit 1; printf 'true' ;;
  clear) guard; stopped; private_file; want=$(expected '.selectorHash'); got=$(sha256sum "$sibling" | cut -d' ' -f1); [ "$want" = "$got" ]; rm -- "$sibling"; [ ! -e "$sibling" ] && [ ! -L "$sibling" ] || exit 1; guard; printf 'true' ;;
  armed-selector)
    check_startup_unit; census running; private_file
    policy=$(oneshot startup-policy e30=)
    printf '%s' "$policy" | jq -e '.runRecordV11=="0" and .pendingHttpEvidence=="0"' >/dev/null
    prospective=$(printf '%s' "$policy" | jq -er .selectorHash)
     disk=$(sha256sum "$sibling" | cut -d' ' -f1); [ "$disk" = "$prospective" ]
    # Never export selector contents from the worker or print the principal/UUID.
    docker exec lyrashield-worker node --input-type=module -e '
const {createHash}=await import("node:crypto");const v=process.env.LYRASHIELD_EVIDENCE_WRITER_CANARY;
if(!v||!/^[\w-]{1,2048}$/.test(v))process.exit(2);
try{const h=createHash("sha256").update("LYRASHIELD_EVIDENCE_WRITER_CANARY="+v+"\n").digest("hex");if(h!==process.argv[1])process.exit(2);
const s=JSON.parse(Buffer.from(v,"base64url")),p=process.env; if(p.LYRASHIELD_RUN_RECORD_V1_1!=="0"||p.LYRASHIELD_PENDING_HTTP_EVIDENCE!=="0"||s.productRevision!==p.LYRASHIELD_PRODUCT_REVISION||s.engineRevision!==p.LYRASHIELD_ENGINE_REVISION||s.workerImageDigest!==p.LYRASHIELD_WORKER_IMAGE_DIGEST||p.LYRASHIELD_IMAGE!=="ghcr.io/ecryptoguru/lyrashield-sandbox@"+s.sandboxImageDigest)process.exit(2);
console.log(JSON.stringify({preparedFileHash:h,runningFileHash:h,inputHash:s.inputHash,sandboxDigest:s.sandboxImageDigest,capUsd:s.capUsd,issuedAtMs:s.issuedAtMs,expiresAtMs:s.expiresAtMs,protectedFile:true,hostTimeMs:Date.now()}))}catch{process.exit(2)}' "$disk" ;;
  worker)
    check_startup_unit; census running
    policy=$(oneshot startup-policy e30=)
    printf '%s' "$policy" | jq -e '.runRecordV11=="0" and .pendingHttpEvidence=="0"' >/dev/null
    if [ ! -e "$sibling" ] && [ ! -L "$sibling" ]; then
      printf '%s' "$policy" | jq -e '.selectorHash==null' >/dev/null; selector=absent
    else
      private_file
      selector=$(sha256sum "$sibling" | cut -d' ' -f1)
      [ "$(printf '%s' "$policy" | jq -er .selectorHash)" = "$selector" ]
    fi
    [ "$(systemctl is-active "$active")" = active ] && [ "$(systemctl is-enabled "$active")" = enabled ] || exit 1
    [ "$(docker inspect lyrashield-worker --format '{{.State.Health.Status}}')" = healthy ]
    [ "$(docker inspect lyrashield-worker --format '{{.Config.Image}}')" = "$image" ]
    actual=$(docker inspect lyrashield-worker --format '{{.Image}}'); [ -n "$actual" ] && [ "$actual" = "$(docker image inspect "$image" --format '{{.Id}}')" ] || exit 1
    for ref in "$image" "$sandbox"; do refs=$(docker image inspect "$ref" --format '{{range .RepoDigests}}{{println .}}{{end}}'); printf '%s\n' "$refs" | grep -Fxq "$ref"; done
    docker exec lyrashield-worker node -e 'const p=process.env,v=p.LYRASHIELD_EVIDENCE_WRITER_CANARY; const selected=v?require("node:crypto").createHash("sha256").update("LYRASHIELD_EVIDENCE_WRITER_CANARY="+v+"\n").digest("hex"):"absent";
if(selected!==process.argv[3]||p.LYRASHIELD_RUN_RECORD_V1_1!=="0"||p.LYRASHIELD_PENDING_HTTP_EVIDENCE!=="0")process.exit(2);
if(p.LYRASHIELD_IMAGE!==process.argv[1]||p.LYRASHIELD_WORKER_IMAGE_DIGEST!==process.argv[2])process.exit(2);
console.log(JSON.stringify({productRevision:p.LYRASHIELD_PRODUCT_REVISION,engineRevision:p.LYRASHIELD_ENGINE_REVISION,digest:p.LYRASHIELD_WORKER_IMAGE_DIGEST,imageIdMatchesDigest:true,healthy:true,consumers:1,runRecordV11:p.LYRASHIELD_RUN_RECORD_V1_1,pendingHttpEvidence:p.LYRASHIELD_PENDING_HTTP_EVIDENCE,sandboxDigest:process.argv[1].split("@")[1],sandboxImageMatchesRuntime:true,canarySelectorPresent:Boolean(p.LYRASHIELD_EVIDENCE_WRITER_CANARY)}))' "$sandbox" "${image##*@}" "$selector" ;;
esac
