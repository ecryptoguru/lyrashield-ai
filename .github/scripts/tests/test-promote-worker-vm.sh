#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="$repo/.github/scripts/promote-worker-vm.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

digest="sha256:$(printf 'a%.0s' {1..64})"
target="ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@${digest}"
app_revision=$(printf 'b%.0s' {1..40})
engine_revision=$(printf 'c%.0s' {1..40})

write_mocks() {
  local case_dir=$1
  mkdir -p "$case_dir/bin"

  cat > "$case_dir/bin/systemctl" <<'MOCK'
#!/bin/sh
set -eu
command=$1
shift
[ "${1:-}" != "--quiet" ] || shift
unit=${1:-}
case "$command:$unit" in
  is-active:lyrashield-worker-egress-refresh.timer)
    [ "$(cat "$MOCK_TIMER_ACTIVE")" = 1 ] ;;
  is-active:lyrashield-worker-egress-refresh.service)
    exit 1 ;;
  is-active:lyrashield-worker.service)
    [ "$(cat "$MOCK_SERVICE_ACTIVE")" = 1 ] ;;
  is-enabled:lyrashield-worker.service)
    [ "$(cat "$MOCK_SERVICE_ENABLED")" = 1 ] ;;
  is-enabled:lyrashield-worker-egress-refresh.timer)
    [ "$(cat "$MOCK_TIMER_ENABLED")" = 1 ] ;;
  enable:*)
    for unit in "$@"; do
      case "$unit" in
        lyrashield-worker.service) printf 1 > "$MOCK_SERVICE_ENABLED" ;;
        lyrashield-worker-egress-refresh.timer) printf 1 > "$MOCK_TIMER_ENABLED" ;;
        *) echo "unexpected enabled unit: $unit" >&2; exit 1 ;;
      esac
    done ;;
  stop:lyrashield-worker-egress-refresh.timer)
    printf 0 > "$MOCK_TIMER_ACTIVE" ;;
  start:lyrashield-worker-egress-refresh.timer)
    printf 1 > "$MOCK_TIMER_ACTIVE" ;;
  restart:lyrashield-worker.service)
    printf 1 > "$MOCK_SERVICE_ACTIVE"
    if [ -n "${MOCK_REPLACEMENT_STOP:-}" ] && [ -s "$MOCK_ADMISSION_STOP" ]; then
      printf '%s' "$MOCK_REPLACEMENT_STOP" > "$MOCK_ADMISSION_STOP"
    fi ;;
  reset-failed:lyrashield-worker.service) ;;
  *) echo "unexpected systemctl call: $command $unit" >&2; exit 1 ;;
esac
MOCK

  cat > "$case_dir/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
case "$1:$2" in
  inspect:lyrashield-worker)
    case "$*" in
      *State.Health*) printf 'healthy\n' ;;
      *'{{.Image}}'*) printf '%s\n' 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' ;;
      *Config.Image*)
        if [ "${MOCK_FAIL_IMAGE_CHECK:-0}" = 1 ]; then
          printf '%s\n' 'ghcr.io/example/worker@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        else
          printf '%s\n' "$MOCK_TARGET"
        fi ;;
      *) exit 1 ;;
    esac ;;
  exec:-w)
    case "$*" in
      *'redis.call("GET"'*)
        for argument in "$@"; do expected_stop=$argument; done
        if [ "$(cat "$MOCK_ADMISSION_STOP")" = "$expected_stop" ]; then
          : > "$MOCK_ADMISSION_STOP"
          printf '1\n'
        else
          printf '0\n'
        fi ;;
      *'redis.call("EXISTS"'*)
        if [ -s "$MOCK_ADMISSION_STOP" ]; then
          printf '0\n'
        else
          promotion_stop='{"operator":"github-actions","reason":"worker-promotion"}'
          printf '%s' "$promotion_stop" > "$MOCK_ADMISSION_STOP"
          printf '1\n%s\n' "$promotion_stop"
        fi ;;
      *getSystemPrisma*) printf '%s\n' '{"nonterminal":0,"scan":{"wait":0,"active":0,"delayed":0,"prioritized":0},"webhook":{"wait":0,"active":0,"delayed":0,"prioritized":0}}' ;;
      *) : ;;
    esac ;;
  exec:lyrashield-worker)
    case "$*" in
      *LYRASHIELD_PRODUCT_REVISION*) printf '%s\n' "$MOCK_APP_REVISION" ;;
      *LYRASHIELD_ENGINE_REVISION*) printf '%s\n' "$MOCK_ENGINE_REVISION" ;;
      *LYRASHIELD_WORKER_IMAGE_DIGEST*) printf '%s\n' "${MOCK_TARGET##*@}" ;;
      *) exit 1 ;;
    esac ;;
  login:*|pull:*) : ;;
  info:--format) printf '/\n' ;;
  image:prune) : ;;
  image:inspect)
    case "$*" in
      *'{{.Size}}'*) printf '1000\n' ;;
      *org.opencontainers.image.revision*) printf '%s\n' "$MOCK_APP_REVISION" ;;
      *io.lyrashield.engine.revision*) printf '%s\n' "$MOCK_ENGINE_REVISION" ;;
      *) exit 1 ;;
    esac ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
MOCK

  cat > "$case_dir/bin/curl" <<'MOCK'
#!/bin/sh
exit 0
MOCK
cat > "$case_dir/bin/df" <<'MOCK'
#!/bin/sh
printf '%s\n' 'Filesystem 1-blocks Used Available Capacity Mounted on'
printf '/dev/mock 10000000000 1000 %s 1%% /\n' "$MOCK_FREE_BYTES"
MOCK
  cat > "$case_dir/bin/chown" <<'MOCK'
#!/bin/sh
exit 0
MOCK
  chmod +x "$case_dir/bin/"*
}

run_case() {
  local name=$1 timer_active=$2 service_enabled=$3 timer_enabled=$4 expected=$5
  local service_active=${6:-1} existing_stop=${7:-} fail_image_check=${8:-0}
  local replacement_stop=${9:-}
  local free_bytes=${10:-9999999000}
  local case_dir="$tmp/$name"
  mkdir -p "$case_dir"
  write_mocks "$case_dir"
  printf '%s' "$service_active" > "$case_dir/service-active"
  printf '%s' "$timer_active" > "$case_dir/timer-active"
  printf '%s' "$service_enabled" > "$case_dir/service-enabled"
  printf '%s' "$timer_enabled" > "$case_dir/timer-enabled"
  printf '%s' "$existing_stop" > "$case_dir/admission-stop"
  : > "$case_dir/docker.log"
  printf 'LYRASHIELD_WORKER_IMAGE=%s\nGHCR_USERNAME=test-user\n' "$target" > "$case_dir/runtime.conf"
  printf 'GHCR_TOKEN=test-token\n' > "$case_dir/worker.env"

  set +e
  output=$(
    PATH="$case_dir/bin:$PATH" \
      MOCK_TARGET="$target" \
      MOCK_APP_REVISION="$app_revision" \
      MOCK_ENGINE_REVISION="$engine_revision" \
      MOCK_SERVICE_ACTIVE="$case_dir/service-active" \
      MOCK_TIMER_ACTIVE="$case_dir/timer-active" \
      MOCK_SERVICE_ENABLED="$case_dir/service-enabled" \
      MOCK_TIMER_ENABLED="$case_dir/timer-enabled" \
      MOCK_ADMISSION_STOP="$case_dir/admission-stop" \
      MOCK_DOCKER_LOG="$case_dir/docker.log" \
      MOCK_FREE_BYTES="$free_bytes" \
      MOCK_FAIL_IMAGE_CHECK="$fail_image_check" \
      MOCK_REPLACEMENT_STOP="$replacement_stop" \
      LYRASHIELD_WORKER_RUNTIME_CONFIG="$case_dir/runtime.conf" \
      LYRASHIELD_WORKER_ENV_FILE="$case_dir/worker.env" \
      sh "$script" "$target" "$app_revision" "$engine_revision" 2>&1
  )
  status=$?
  set -e

  if [ "$expected" = success ]; then
    [ "$status" -eq 0 ]
    grep -Fq 'Worker service state: active enabled' <<< "$output"
    grep -Fq 'Worker egress refresh timer state: active enabled' <<< "$output"
    grep -Fq "Worker promotion passed for ${digest}" <<< "$output"
  else
    [ "$status" -ne 0 ]
    if grep -Fq 'Worker promotion passed' <<< "$output"; then
      echo "failed promotion emitted a success marker" >&2
      exit 1
    fi
    if [ "$name" = insufficient-disk ]; then
      grep -Fq 'Worker image pull requires' <<< "$output"
    fi
  fi
  grep -Fq 'image prune --all --force' "$case_dir/docker.log"
  if [ -n "$replacement_stop" ]; then
    [ "$(cat "$case_dir/admission-stop")" = "$replacement_stop" ]
    grep -Fq 'Newer scan admission stop preserved' <<< "$output"
  elif [ -n "$existing_stop" ]; then
    [ "$(cat "$case_dir/admission-stop")" = "$existing_stop" ]
    grep -Fq 'Existing scan admission stop preserved' <<< "$output"
  else
    [ ! -s "$case_dir/admission-stop" ]
  fi
}

run_case healthy 1 1 1 success
run_case repairs-inactive-timer 0 1 1 success
run_case repairs-disabled-units 1 0 0 success
run_case repairs-inactive-service 1 1 1 success 0
run_case preserves-existing-stop 1 1 1 success 1 '{"operator":"on-call","reason":"evidence-kek-rotation"}'
run_case preserves-newer-stop 1 1 1 success 1 '' 0 '{"operator":"on-call","reason":"new-incident"}'
run_case resumes-owned-stop-on-rollback 1 1 1 failure 1 '' 1
run_case preserves-existing-stop-on-rollback 1 1 1 failure 1 '{"operator":"on-call","reason":"evidence-kek-rotation"}' 1
run_case insufficient-disk 1 1 1 failure 1 '' 0 '' 1000

echo "Worker promotion systemd proof passed."
