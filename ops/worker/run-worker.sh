#!/bin/sh
set -eu


runtime_config="${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}"
environment_file="${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}"
worker_env_lib="${LYRASHIELD_WORKER_ENV_LIB:-/opt/lyrashield-worker-host/worker-env.sh}"

if [ ! -r "$worker_env_lib" ]; then
  echo "Worker environment library is unavailable: $worker_env_lib" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$worker_env_lib"

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

# Fixed host path: a matching /2 image is insufficient during empty-state
# maintenance. This runs before registry login, pulls or any consumer startup.
empty_state_fence=/var/lib/lyrashield/webhook-empty-state/fence.json
if [ -e "$empty_state_fence" ] || [ -L "$empty_state_fence" ]; then
  fence_verifier=/opt/lyrashield-worker-host/ops/worker/webhook-empty-state-startup-fence.mjs
  [ ! -L "$fence_verifier" ] && [ "$(stat -c '%u:%a' "$fence_verifier")" = 0:644 ] || exit 1
  node "$fence_verifier"
fi

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

is_64_hex() {
  value=$1
  case "$value" in
    ''|*[!0-9a-fA-F]*) return 1 ;;
  esac
  [ "${#value}" -eq 64 ]
}

# Worker execution provenance comes ONLY from the immutable image reference and
# its verified OCI labels. Never accept manually typed revisions: the worker
# binds these values into every result manifest checksum, so they must be the
# exact values the deploy workflow verified.
worker_digest=${LYRASHIELD_WORKER_IMAGE##*@}
case "$worker_digest" in
  sha256:*) ;;
  *)
    echo "Worker image digest must start with sha256:" >&2
    exit 1
    ;;
esac
is_64_hex "${worker_digest#sha256:}" || {
  echo "Worker image digest must be sha256:<64 hex>" >&2
  exit 1
}

# The engine rejects unsafe sandbox topology at scan admission. Check the same
# host contract before registry traffic or starting a queue consumer so a drifted
# network cannot advertise readiness and accept work that will inevitably fail.
if ! sandbox_network_state=$(docker network inspect --format '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.enable_icc"}}' "$LYRASHIELD_SANDBOX_NETWORK" 2>/dev/null) ||
  [ "$sandbox_network_state" != 'bridge|true|false' ]; then
  echo "Sandbox network '$LYRASHIELD_SANDBOX_NETWORK' must exist with Driver=bridge, Internal=true and com.docker.network.bridge.enable_icc=false." >&2
  echo "Stop scan admission, drain active work and repair the network through the guarded maintenance procedure before restarting the worker." >&2
  exit 1
fi

extract_env_value() {
  var="$1"
  file="$2"
  if [ -r "$file" ]; then
    sed -n "s/^${var}=//p" "$file" | head -n 1
  fi
}

login_to_registry() {
  image="$1"
  registry_host=${image%%/*}
  case "$registry_host" in
    *.azurecr.io)
      acr_name=${registry_host%%.*}
      if ! command -v az >/dev/null 2>&1; then
        echo "Azure CLI is required to authenticate $registry_host" >&2
        exit 1
      fi
      if ! az login --identity --allow-no-subscriptions >/dev/null 2>&1 || ! az acr login --name "$acr_name" >/dev/null 2>&1; then
        echo "Unable to authenticate $registry_host through the VM managed identity" >&2
        exit 1
      fi
      ;;
    ghcr.io)
      if [ -z "${GHCR_TOKEN:-}" ]; then
        GHCR_TOKEN=$(extract_env_value GHCR_TOKEN "$environment_file")
      fi
      if [ -z "${GHCR_TOKEN:-}" ]; then
        echo "GHCR_TOKEN is required to authenticate $image from GHCR" >&2
        exit 1
      fi
      if [ -z "${GHCR_USERNAME:-}" ]; then
        GHCR_USERNAME=$(extract_env_value GHCR_USERNAME "$environment_file")
      fi
      if [ -z "${GHCR_USERNAME:-}" ]; then
        echo "GHCR_USERNAME is required to authenticate $image from GHCR" >&2
        exit 1
      fi
      if ! printf '%s\n' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null 2>&1; then
        echo "Unable to authenticate ghcr.io for $image" >&2
        exit 1
      fi
      ;;
    *)
      echo "Unsupported container registry: $registry_host (image: $image)" >&2
      exit 1
      ;;
  esac
}

logged_in=""
for image in "$LYRASHIELD_WORKER_IMAGE" "$LYRASHIELD_SANDBOX_IMAGE"; do
  registry_host=${image%%/*}
  case " $logged_in " in
    *" $registry_host "*) ;;
    *) login_to_registry "$image"; logged_in="$logged_in $registry_host" ;;
  esac
done

# A newly promoted immutable digest may not exist in the VM's local Docker
# cache. Pull only when absent so routine service restarts do not create
# unnecessary registry traffic.
for image in "$LYRASHIELD_WORKER_IMAGE" "$LYRASHIELD_SANDBOX_IMAGE"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull "$image" >/dev/null
  fi
done

worker_shared_root=/var/lib/lyrashield/worker
# Computing the argument list here keeps the image-label provenance validation
# ahead of the privileged shared-root chown below.
env_args=$(lyrashield_worker_env_args "$runtime_config" "$environment_file" "$worker_shared_root")

# ExecStartPre refreshes secrets. Validate the resulting environment before any
# queue consumer starts, including after a host restart during maintenance.
cutover_receipt=${LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE:-/var/lib/lyrashield/webhook-claims-cutover.json}
if [ -e "$cutover_receipt" ]; then
  [ ! -L "$cutover_receipt" ] && [ "$(stat -c '%u:%a' "$cutover_receipt")" = 0:600 ] || exit 1
  saved_cutover=$(cat "$cutover_receipt")
  # Intentional splitting of the validated worker-env.sh argument list.
  # shellcheck disable=SC2086,SC2016
  # This probe mounts no host paths; keep its compiler cache in a bounded tmpfs.
  docker run --rm --network none --env-file "$environment_file" $env_args \
    --env TMPDIR=/tmp --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
    -w /app/apps/worker "$LYRASHIELD_WORKER_IMAGE" \
    node --import tsx --input-type=module -e 'import {createHash} from "node:crypto"; const [raw,image]=process.argv.slice(1); const receipt=JSON.parse(raw); const billing=await import("@lyrashield/billing"); const recovery=await import("file:///opt/lyrashield-worker-host/webhook-cutover-recovery.mjs").catch(error=>{if(error.code==="ERR_MODULE_NOT_FOUND") return null; throw error;}); if(recovery){recovery.assertWebhookCutoverWorkerIdentity({receipt,workerImage:image,productRevision:process.env.LYRASHIELD_PRODUCT_REVISION,engineRevision:process.env.LYRASHIELD_ENGINE_REVISION,workerDigest:process.env.LYRASHIELD_WORKER_IMAGE_DIGEST,protocol:billing.WEBHOOK_TRACK_CLAIM_PROTOCOL,environment:process.env});} else {const hash=value=>createHash("sha256").update(value??"").digest("hex"); const digest=image.match(/@sha256:([a-f0-9]{64})$/)?.[1]; if((receipt.recoveryCandidates??[]).length>0 || receipt.candidateWorkerImage!==image || receipt.productRevision!==process.env.LYRASHIELD_PRODUCT_REVISION || receipt.candidateProductRevision!==process.env.LYRASHIELD_PRODUCT_REVISION || receipt.candidateEngineRevision!==process.env.LYRASHIELD_ENGINE_REVISION || process.env.LYRASHIELD_WORKER_IMAGE_DIGEST!==`sha256:${digest}` || billing.WEBHOOK_TRACK_CLAIM_PROTOCOL!=="durable-claims/2" || receipt.candidateWebhookTrackClaimProtocol!=="durable-claims/2" || receipt.databaseUrlSha256!==hash(process.env.DATABASE_URL) || receipt.databaseSystemUrlSha256!==hash(process.env.DATABASE_SYSTEM_URL) || receipt.redisUrlSha256!==hash(process.env.REDIS_URL)) throw new Error("Legacy cutover worker does not match its recorded candidate");}' "$saved_cutover" "$LYRASHIELD_WORKER_IMAGE"
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

install -d -m 700 "$worker_shared_root" "$worker_shared_root/lyrashield_runs" "$worker_shared_root/tmp"

docker rm -f lyrashield-worker >/dev/null 2>&1 || true
docker run --rm \
  --network none \
  --user 0:0 \
  --mount type=bind,src="$worker_shared_root",dst="$worker_shared_root" \
  --entrypoint sh \
  "$LYRASHIELD_WORKER_IMAGE" \
  -c "chown -R lyrashield:lyrashield '$worker_shared_root' && chmod 700 '$worker_shared_root' '$worker_shared_root/lyrashield_runs' '$worker_shared_root/tmp'"

# Intentional word splitting: worker-env.sh emits one `--env` argument pair per
# line and every emitted value is whitespace-free.
# shellcheck disable=SC2086
docker create \
  --name lyrashield-worker \
  --network bridge \
  "$@" \
  --env-file "$environment_file" \
  $env_args \
  --group-add "$socket_group" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src="$worker_shared_root",dst="$worker_shared_root" \
  --tmpfs /tmp:rw,nosuid,nodev,size=4g \
  --tmpfs /lyrashield-retests:rw,nosuid,nodev,noexec,size=1g,mode=1777 \
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

# Keep the worker on its outbound bridge only. Joining the untrusted sandbox
# bridge would let a raw-socket sandbox spoof a worker-only same-bridge rule.
# Install the bounded cross-bridge control policy before starting any consumer.
worker_egress_script="${LYRASHIELD_WORKER_EGRESS_SCRIPT:-/usr/local/libexec/lyrashield-refresh-egress}"
if [ ! -x "$worker_egress_script" ]; then
  echo "Worker egress policy helper is unavailable: $worker_egress_script" >&2
  exit 1
fi
LYRASHIELD_REQUIRE_SANDBOX_CONTROL=1 "$worker_egress_script"
exec docker start --attach lyrashield-worker
