#!/usr/bin/env bash
set -euo pipefail

root=$(git rev-parse --show-toplevel)
script="$root/ops/worker/webhook-cutover-readonly-diagnostic.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat >"$tmp/bin/timeout" <<'SH'
#!/bin/sh
[ "$1" = --foreground ] && shift
shift
exec "$@"
SH
cat >"$tmp/bin/systemctl" <<'SH'
#!/bin/sh
case "$1" in
  is-active) case "$2" in *worker.service) printf inactive;; *) printf active;; esac ;;
  is-enabled) printf disabled;;
  status) printf 'database connection ECONNREFUSED leaked-diagnostic-sentinel=do-not-print\n'; exit 1 ;;
  *) exit 2 ;;
esac
SH
cat >"$tmp/bin/journalctl" <<'SH'
#!/bin/sh
printf 'worker error leaked-journal-sentinel=do-not-print\n'
SH
cat >"$tmp/bin/stat" <<'SH'
#!/bin/sh
[ "$1" = -c ] || exit 2
printf '0:600\n'
SH
cat >"$tmp/bin/docker" <<'SH'
#!/bin/sh
case "$1" in
  image)
    case "$*" in
      *io.lyrashield.engine.revision*) printf '%040d\n' 2 ;;
      *org.opencontainers.image.revision*) printf '%040d\n' 1 ;;
      *) exit 2 ;;
    esac
    ;;
  inspect)
    case "$*" in
      *'.State.Status'*) printf exited ;;
      *'.State.Health'*) printf unhealthy ;;
      *'.Config.Image'*) printf 'ghcr.io/example/worker:fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
      *) exit 2 ;;
    esac
    ;;
  exec)
    case "$4" in
      LYRASHIELD_PRODUCT_REVISION) printf '%040d\n' 1 ;;
      LYRASHIELD_ENGINE_REVISION) printf '%040d\n' 2 ;;
      LYRASHIELD_WORKER_IMAGE_DIGEST) printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
      *) exit 2 ;;
    esac
    ;;
  run)
    printf '%s\n' 'docker-error leaked-docker-sentinel=do-not-print' >&2
    printf '%s\n' 'receipt_present=true' 'receipt_metadata={"phase":"writers-stopped","owner":"37516632066:1","runId":"37516632066","sourceSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","attempts":[1,2],"lastAttempt":2}' 'receipt_matches_expected=true' 'redis_admission_owner_match=true'
    ;;
  *) exit 2 ;;
esac
SH
chmod +x "$tmp/bin/timeout" "$tmp/bin/systemctl" "$tmp/bin/journalctl" "$tmp/bin/stat" "$tmp/bin/docker"

revision=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
config="$tmp/runtime.conf"
printf 'LYRASHIELD_WORKER_IMAGE=ghcr.io/example/worker:fixture@sha256:%s\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:%s\nLYRASHIELD_SANDBOX_NETWORK=bridge\n' "$digest" "$digest" >"$config"
env_file="$tmp/worker.env"
printf 'REDIS_URL=redis://secret-sentinel\n' >"$env_file"
receipt="$tmp/receipt.json"
printf '{"admissionStopValue":"receipt-secret-sentinel"}\n' >"$receipt"
chmod 600 "$receipt"
env_lib="$tmp/worker-env.sh"
cat >"$env_lib" <<'SH'
lyrashield_worker_env_args() { printf '%s\n' '--env NODE_ENV=production'; }
SH

output=$(PATH="$tmp/bin:$PATH" \
  LYRASHIELD_WORKER_RUNTIME_CONFIG="$config" \
  LYRASHIELD_WORKER_ENV_FILE="$env_file" \
  LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE="$receipt" \
  LYRASHIELD_WORKER_ENV_LIB="$env_lib" \
  sh "$script" 37516632066 "$revision" 37516632066:1)

printf '%s\n' "$output" | rg -q '^worker_health_error_category=DATABASE_CONNECTIVITY$'
printf '%s\n' "$output" | rg -q "^worker_image_digest=sha256:$digest$"
printf '%s\n' "$output" | rg -q '^LYRASHIELD_PRODUCT_REVISION=0000000000000000000000000000000000000001$'
printf '%s\n' "$output" | rg -q '^LYRASHIELD_ENGINE_REVISION=0000000000000000000000000000000000000002$'
printf '%s\n' "$output" | rg -q '^redis_admission_owner_match=true$'
if printf '%s\n' "$output" | rg -q 'secret-sentinel|leaked-journal-sentinel|leaked-diagnostic-sentinel|leaked-docker-sentinel'; then
  echo 'diagnostic leaked protected input' >&2
  exit 1
fi

source=$(<"$script")
[[ "$source" == *'journalctl -u "$service" -n 50'* ]]
[[ "$source" == *'redis.get("lyrashield:scan-admission:stopped")'* ]]
[[ "$source" != *'redis.set('* && "$source" != *'redis.del('* && "$source" != *'redis.eval('* ]]
[[ "$source" != *'systemctl restart'* && "$source" != *'systemctl stop'* && "$source" != *'systemctl enable'* && "$source" != *'systemctl disable'* ]]
echo 'Read-only webhook VM diagnostic redaction test passed.'
