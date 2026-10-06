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
      *'inspect ghcr.io/example/worker:fixture@sha256:'*) [ "${MOCK_IMAGE_MISSING:-0}" = 0 ] ;;
      *io.lyrashield.engine.revision*) printf '%040d\n' 2 ;;
      *org.opencontainers.image.revision*) printf '%040d\n' 1 ;;
      *) exit 2 ;;
    esac
    ;;
  inspect)
    [ "${MOCK_CONTAINER_MISSING:-0}" = 0 ] || exit 1
    case "$*" in
      *'.State.Status'*) printf exited ;;
      *'.State.Health'*) printf unhealthy ;;
      *'.Config.Image'*) printf 'ghcr.io/example/worker:fixture@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
      *) exit 2 ;;
    esac
    ;;
  exec)
    [ "${MOCK_CONTAINER_MISSING:-0}" = 0 ] || exit 1
    case "$4" in
      LYRASHIELD_PRODUCT_REVISION) printf '%040d\n' 1 ;;
      LYRASHIELD_ENGINE_REVISION) printf '%040d\n' 2 ;;
      LYRASHIELD_WORKER_IMAGE_DIGEST) printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' ;;
      *) exit 2 ;;
    esac
    ;;
  run)
    if [ -n "${MOCK_DOCKER_RUN_MARKER:-}" ]; then : >"$MOCK_DOCKER_RUN_MARKER"; fi
    case "$*" in *'--pull=never'*) ;; *) exit 2;; esac
    case "$*" in *'--user 0:0'*) ;; *) exit 2;; esac
    case "$*" in *'--cap-drop ALL'*) ;; *) exit 2;; esac
    case "$*" in *'--security-opt no-new-privileges'*) ;; *) exit 2;; esac
    case "$*" in *'--read-only'*) ;; *) exit 2;; esac
    case "$*" in *'/run/cutover-receipt.json:ro'*) ;; *) exit 2;; esac
    case "$*" in *'--network bridge'*) ;; *) exit 2;; esac
    env_file=''
    previous=''
    for arg in "$@"; do
      if [ "$previous" = --env-file ]; then env_file=$arg; break; fi
      previous=$arg
    done
    [ -n "$env_file" ] && [ -f "$env_file" ]
    [ "$(cat "$env_file")" = 'REDIS_URL=redis://secret-sentinel' ]
    ! rg -q 'DATABASE_URL|database-secret-sentinel|other-secret-sentinel' "$env_file"
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
printf 'DATABASE_URL=postgres://database-secret-sentinel\nREDIS_URL=redis://secret-sentinel\nWORKER_TOKEN=other-secret-sentinel\n' >"$env_file"
receipt="$tmp/receipt.json"
printf '{"admissionStopValue":"receipt-secret-sentinel"}\n' >"$receipt"
chmod 600 "$receipt"
run_diagnostic() {
  env PATH="$tmp/bin:$PATH" \
    LYRASHIELD_WORKER_RUNTIME_CONFIG="$config" \
    LYRASHIELD_WORKER_ENV_FILE="$env_file" \
    LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE="$receipt" \
    "$@" sh "$script" 37516632066 "$revision" 37516632066:1
}

run_marker="$tmp/docker-ran"
output=$(run_diagnostic MOCK_DOCKER_RUN_MARKER="$run_marker")
[ -f "$run_marker" ]

printf '%s\n' "$output" | rg -q '^worker_health_error_category=DATABASE_CONNECTIVITY$'
printf '%s\n' "$output" | rg -q '^worker_container_state=exited$'
printf '%s\n' "$output" | rg -q '^worker_container_health=unhealthy$'
printf '%s\n' "$output" | rg -q "^worker_image_digest=sha256:$digest$"
printf '%s\n' "$output" | rg -q '^LYRASHIELD_PRODUCT_REVISION=0000000000000000000000000000000000000001$'
printf '%s\n' "$output" | rg -q '^LYRASHIELD_ENGINE_REVISION=0000000000000000000000000000000000000002$'
printf '%s\n' "$output" | rg -q '^redis_admission_owner_match=true$'
if printf '%s\n' "$output" | rg -q 'secret-sentinel|leaked-journal-sentinel|leaked-diagnostic-sentinel|leaked-docker-sentinel'; then
  echo 'diagnostic leaked protected input' >&2
  exit 1
fi

missing_container_output=$(run_diagnostic MOCK_CONTAINER_MISSING=1)
printf '%s\n' "$missing_container_output" | rg -q '^worker_container_state=unknown$'
printf '%s\n' "$missing_container_output" | rg -q '^worker_container_health=unavailable$'
printf '%s\n' "$missing_container_output" | rg -q '^worker_image_digest=unavailable$'
printf '%s\n' "$missing_container_output" | rg -q '^redis_admission_owner_match=true$'

missing_image_marker="$tmp/missing-image-docker-run"
missing_image_output=$(run_diagnostic MOCK_IMAGE_MISSING=1 MOCK_DOCKER_RUN_MARKER="$missing_image_marker")
printf '%s\n' "$missing_image_output" | rg -q '^receipt_metadata=unavailable$'
[ ! -e "$missing_image_marker" ]

missing_receipt_output=$(run_diagnostic LYRASHIELD_WEBHOOK_CUTOVER_RECEIPT_FILE="$tmp/no-receipt.json")
printf '%s\n' "$missing_receipt_output" | rg -q '^receipt_present=false$'
printf '%s\n' "$missing_receipt_output" | rg -q '^redis_admission_owner_match=unavailable$'

source=$(<"$script")
[[ "$source" == *'journalctl -u "$service" -n 50'* ]]
[[ "$source" == *'redis.get("lyrashield:scan-admission:stopped")'* ]]
[[ "$source" == *'awk '\''/^REDIS_URL=/'* ]]
[[ "$source" == *'--user 0:0 --cap-drop ALL --security-opt no-new-privileges'* ]]
[[ "$source" != *'lyrashield_worker_env_args'* ]]
[[ "$source" == *'docker run --pull=never'* ]]
[[ "$source" != *'redis.set('* && "$source" != *'redis.del('* && "$source" != *'redis.eval('* ]]
[[ "$source" != *'systemctl restart'* && "$source" != *'systemctl stop'* && "$source" != *'systemctl enable'* && "$source" != *'systemctl disable'* ]]
echo 'Read-only webhook VM diagnostic redaction test passed.'
