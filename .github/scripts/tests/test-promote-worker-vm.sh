#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
script="$repo/.github/scripts/promote-worker-vm.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

digest="sha256:$(printf 'a%.0s' {1..64})"
target="ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@${digest}"
old_digest="sha256:$(printf 'd%.0s' {1..64})"
old_image="ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker@${old_digest}"
app_revision=$(printf 'b%.0s' {1..40})
engine_revision=$(printf 'c%.0s' {1..40})

write_mocks() {
  local case_dir=$1
  mkdir -p "$case_dir/bin" "$case_dir/image-assets" "$case_dir/host/libexec" "$case_dir/host/systemd" "$case_dir/host/assets" "$case_dir/promotion"
  for asset in \
    run-worker.sh \
    worker-env.sh \
    refresh-secrets.sh \
    refresh-egress.sh \
    capture-stop-provenance.sh \
    trial-claim-backfill.sh \
    backfill-clear-wrong-trial-claims.ts \
    lyrashield-worker.service \
    lyrashield-worker-secrets.service \
    lyrashield-worker-egress.service \
    lyrashield-worker-egress-refresh.service \
    lyrashield-worker-egress-refresh.timer
  do
    printf 'image asset: %s\n' "$asset" > "$case_dir/image-assets/$asset"
  done
  local host_script
  for host_script in \
    lyrashield-run-worker \
    lyrashield-refresh-secrets \
    lyrashield-refresh-egress \
    lyrashield-capture-worker-stop-provenance
  do
    printf 'installed script: %s\n' "$host_script" > "$case_dir/host/libexec/$host_script"
  done
  cat > "$case_dir/host/libexec/lyrashield-refresh-secrets" <<'MOCK'
#!/bin/sh
set -eu
printf 'refresh-secrets\n' >> "$MOCK_ORDER_LOG"
MOCK
  chmod +x "$case_dir/host/libexec/lyrashield-refresh-secrets"
  for unit in \
    lyrashield-worker.service \
    lyrashield-worker-secrets.service \
    lyrashield-worker-egress.service \
    lyrashield-worker-egress-refresh.service \
    lyrashield-worker-egress-refresh.timer
  do
    printf 'installed unit: %s\n' "$unit" > "$case_dir/host/systemd/$unit"
  done

  cat > "$case_dir/bin/systemctl" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_SYSTEMCTL_LOG"
printf 'systemctl %s\n' "$*" >> "$MOCK_ORDER_LOG"
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
    if [ "${MOCK_RESTART_FAIL:-0}" = 1 ]; then
      echo "simulated worker restart failure" >&2
      exit 1
    fi
    printf 1 > "$MOCK_SERVICE_ACTIVE"
    printf 1 > "$MOCK_CONTAINER_PRESENT"
    if [ -n "${MOCK_REPLACEMENT_STOP:-}" ] && [ -s "$MOCK_ADMISSION_STOP" ]; then
      printf '%s' "$MOCK_REPLACEMENT_STOP" > "$MOCK_ADMISSION_STOP"
    fi ;;
  restart:lyrashield-worker-secrets.service)
    echo "secret dependency restart would terminate the active worker" >&2
    exit 1 ;;
  reset-failed:lyrashield-worker.service) ;;
  daemon-reload:) ;;
  status:*)
    printf '%s\n' 'MOCK worker unit status' ;;
  *) echo "unexpected systemctl call: $command $unit" >&2; exit 1 ;;
esac
MOCK

  cat > "$case_dir/bin/journalctl" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_JOURNALCTL_LOG"
printf '%s\n' 'MOCK worker journal tail'
MOCK

  cat > "$case_dir/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$MOCK_DOCKER_LOG"
printf 'docker %s\n' "$*" >> "$MOCK_ORDER_LOG"
case "$1:$2" in
  inspect:lyrashield-worker)
    [ "$(cat "$MOCK_CONTAINER_PRESENT")" = 1 ] || exit 1
    case "$*" in
      *State.Health*)
        if [ "$(cat "$MOCK_SERVICE_ACTIVE")" = 1 ]; then printf 'healthy\n'; else printf 'starting\n'; fi ;;
      *'{{.Image}}'*) printf '%s\n' 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' ;;
      *Config.Image*)
        if [ "${MOCK_FAIL_IMAGE_CHECK:-0}" = 1 ]; then
          printf '%s\n' 'ghcr.io/example/worker@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        else
          printf '%s\n' "$MOCK_TARGET"
        fi ;;
      *) exit 1 ;;
    esac ;;
  run:*)
    case "$*" in
      *'cjson.decode'*)
        promotion_stop='{"operator":"github-actions","reason":"worker-promotion"}'
        if [ ! -s "$MOCK_ADMISSION_STOP" ]; then
          printf '%s' "$promotion_stop" > "$MOCK_ADMISSION_STOP"
          printf '1\n%s\n' "$promotion_stop"
        elif grep -Fq '"operator":"github-actions"' "$MOCK_ADMISSION_STOP" && grep -Fq '"reason":"worker-promotion"' "$MOCK_ADMISSION_STOP"; then
          promotion_stop='{"operator":"github-actions","reason":"worker-promotion"}'
          printf '%s' "$promotion_stop" > "$MOCK_ADMISSION_STOP"
          printf '1\n%s\nreclaimed\n' "$promotion_stop"
        else
          printf '0\n'
        fi ;;
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
  exec:-w)
    echo "promotion must not evaluate inside the live worker: $*" >&2
    exit 1 ;;
  exec:lyrashield-worker)
    case "$*" in
      *printenv\ REDIS_URL*)
        if [ "$(cat "$MOCK_SERVICE_ACTIVE")" = 1 ]; then printf '%s\n' 'rediss://current@redis.test:6379'; else printf '%s\n' 'rediss://retired@retired-redis.test:6379'; fi ;;
      *printenv\ DATABASE_URL*)
        if [ "$(cat "$MOCK_SERVICE_ACTIVE")" = 1 ]; then printf '%s\n' 'postgresql://current@database.test:5432/lyrashield'; else printf '%s\n' 'postgresql://retired@retired-database.test:5432/lyrashield'; fi ;;
      *LYRASHIELD_PRODUCT_REVISION*) printf '%s\n' "$MOCK_APP_REVISION" ;;
      *LYRASHIELD_ENGINE_REVISION*) printf '%s\n' "$MOCK_ENGINE_REVISION" ;;
      *LYRASHIELD_WORKER_IMAGE_DIGEST*) printf '%s\n' "${MOCK_TARGET##*@}" ;;
      *) exit 1 ;;
    esac ;;
  login:*|pull:*) : ;;
  create:*) printf 'asset-container\n' ;;
  cp:*) cp -R "$MOCK_IMAGE_ASSETS/." "$3" ;;
  rm:*) : ;;
  info:--format) printf '/\n' ;;
  image:prune) : ;;
  image:inspect)
    case "$*" in
      *'{{.Size}}'*)
        case "$*" in
          *"$MOCK_OLD_IMAGE"*) [ "$MOCK_OLD_IMAGE_PRESENT" = 1 ] || exit 1 ;;
        esac
        printf '1000\n' ;;
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
  local container_present=${11:-1}
  local old_image_present=${12:-1}
  local floor_bytes=${13:-}
  local floor_via=${14:-env}
  local restart_fails=${15:-0}
  local floor_env=""
  if [ "$floor_via" = env ]; then
    floor_env=$floor_bytes
  fi
  local case_dir="$tmp/$name"
  mkdir -p "$case_dir"
  write_mocks "$case_dir"
  printf '%s' "$service_active" > "$case_dir/service-active"
  printf '%s' "$container_present" > "$case_dir/container-present"
  printf '%s' "$timer_active" > "$case_dir/timer-active"
  printf '%s' "$service_enabled" > "$case_dir/service-enabled"
  printf '%s' "$timer_enabled" > "$case_dir/timer-enabled"
  printf '%s' "$existing_stop" > "$case_dir/admission-stop"
  : > "$case_dir/docker.log"
  : > "$case_dir/systemctl.log"
  : > "$case_dir/journalctl.log"
  : > "$case_dir/order.log"
  printf 'LYRASHIELD_WORKER_IMAGE=%s\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:%s\nGHCR_USERNAME=test-user\n' "$old_image" "$(printf 'e%.0s' {1..64})" > "$case_dir/runtime.conf"
  if [ "$floor_via" = config ] && [ -n "$floor_bytes" ]; then
    printf 'LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES=%s\n' "$floor_bytes" >> "$case_dir/runtime.conf"
  fi
  printf 'GHCR_TOKEN=test-token\nREDIS_URL=rediss://current@redis.test:6379\nDATABASE_URL=postgresql://current@database.test:5432/lyrashield\n' > "$case_dir/worker.env"

  set +e
  output=$(
    PATH="$case_dir/bin:$PATH" \
      MOCK_TARGET="$target" \
      MOCK_APP_REVISION="$app_revision" \
      MOCK_ENGINE_REVISION="$engine_revision" \
      MOCK_SERVICE_ACTIVE="$case_dir/service-active" \
      MOCK_CONTAINER_PRESENT="$case_dir/container-present" \
      MOCK_TIMER_ACTIVE="$case_dir/timer-active" \
      MOCK_SERVICE_ENABLED="$case_dir/service-enabled" \
      MOCK_TIMER_ENABLED="$case_dir/timer-enabled" \
      MOCK_ADMISSION_STOP="$case_dir/admission-stop" \
      MOCK_DOCKER_LOG="$case_dir/docker.log" \
      MOCK_SYSTEMCTL_LOG="$case_dir/systemctl.log" \
      MOCK_JOURNALCTL_LOG="$case_dir/journalctl.log" \
      MOCK_ORDER_LOG="$case_dir/order.log" \
      MOCK_IMAGE_ASSETS="$case_dir/image-assets" \
      MOCK_FREE_BYTES="$free_bytes" \
      MOCK_OLD_IMAGE="$old_image" \
      MOCK_OLD_IMAGE_PRESENT="$old_image_present" \
      MOCK_FAIL_IMAGE_CHECK="$fail_image_check" \
      MOCK_REPLACEMENT_STOP="$replacement_stop" \
      MOCK_RESTART_FAIL="$restart_fails" \
      LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES="$floor_env" \
      LYRASHIELD_WORKER_RUNTIME_CONFIG="$case_dir/runtime.conf" \
      LYRASHIELD_WORKER_ENV_FILE="$case_dir/worker.env" \
      LYRASHIELD_WORKER_PROMOTION_STATE_DIR="$case_dir/promotion" \
      LYRASHIELD_WORKER_HOST_LIBEXEC_DIR="$case_dir/host/libexec" \
      LYRASHIELD_WORKER_HOST_ASSETS_DIR="$case_dir/host/assets" \
      LYRASHIELD_WORKER_ENV_LIB="$repo/ops/worker/worker-env.sh" \
      LYRASHIELD_WORKER_SYSTEMD_DIR="$case_dir/host/systemd" \
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
    grep -Fq 'Worker promotion failed during:' <<< "$output"
    if grep -Fq 'Worker promotion passed' <<< "$output"; then
      echo "failed promotion emitted a success marker" >&2
      exit 1
    fi
    if [ "$name" = insufficient-disk ]; then
      grep -Fq 'Worker image pull requires' <<< "$output"
    fi
    if [ "$name" = missing-rollback-tight-disk ]; then
      grep -Fq 'No local rollback image' <<< "$output"
      grep -Fq 'Worker image pull requires' <<< "$output"
    fi
    if [ "$name" = missing-rollback-bad-floor ]; then
      grep -Fq 'LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES must be a positive integer' <<< "$output"
    fi
  fi
  if [ "$name" = missing-rollback-bad-floor ]; then
    # The malformed floor exits at the disk-preflight sizing step, before any
    # prune, so the usual docker-log assertions do not apply.
    :
  elif [ "$container_present" = 1 ]; then
    grep -Fq 'image prune --all --force' "$case_dir/docker.log"
  else
    grep -Fxq "image inspect $old_image --format {{.Size}}" "$case_dir/docker.log"
    grep -Fq 'image prune --force' "$case_dir/docker.log"
    if grep -Fq 'image prune --all --force' "$case_dir/docker.log"; then
      echo "missing-container recovery pruned its rollback image" >&2
      exit 1
    fi
  fi
  if [ "$expected" = success ]; then
    # Exactly one restart and it happens after the admission-stop claim and
    # the empty-queue check: a scan admitted before promotion finishes against
    # the old worker before the container is replaced.
    [ "$(grep -Fxc 'restart lyrashield-worker.service' "$case_dir/systemctl.log")" -eq 1 ]
    if grep -Fxq 'restart lyrashield-worker-secrets.service' "$case_dir/systemctl.log"; then
      echo "promotion restarted the secret dependency and could terminate the active worker" >&2
      exit 1
    fi
    restart_line=$(grep -Fn 'systemctl restart lyrashield-worker.service' "$case_dir/order.log" | cut -d: -f1)
    claim_line=$(grep -Fn 'cjson.decode' "$case_dir/order.log" | head -n 1 | cut -d: -f1)
    queue_line=$(grep -Fn 'getSystemPrisma' "$case_dir/order.log" | head -n 1 | cut -d: -f1)
    [ -n "$restart_line" ] && [ -n "$claim_line" ] && [ -n "$queue_line" ]
    [ "$restart_line" -gt "$claim_line" ] && [ "$restart_line" -gt "$queue_line" ]
    [ -f "$case_dir/host/assets/worker-env.sh" ]
    [ -x "$case_dir/host/libexec/lyrashield-trial-claim-backfill" ]
    [ -f "$case_dir/host/assets/backfill-clear-wrong-trial-claims.ts" ]
    if [ "$name" = missing-rollback-image ]; then
      grep -Fq 'No local rollback image' <<< "$output"
    fi
    if [ "$name" = missing-rollback-tunable-floor ]; then
      grep -Fq 'No local rollback image' <<< "$output"
      grep -Fq '2147483648-byte floor' <<< "$output"
    fi
  else
    # A failed first deployment must not strand a privileged maintenance
    # runner or its source on the VM after host-asset rollback.
    [ ! -e "$case_dir/host/libexec/lyrashield-trial-claim-backfill" ]
    [ ! -e "$case_dir/host/assets/backfill-clear-wrong-trial-claims.ts" ]
  fi
  if [ -n "$replacement_stop" ]; then
    [ "$(cat "$case_dir/admission-stop")" = "$replacement_stop" ]
    grep -Fq 'Newer scan admission stop preserved' <<< "$output"
  elif [ "$name" = reclaims-stale-promotion-stop ]; then
    [ ! -s "$case_dir/admission-stop" ]
    grep -Fq 'Reclaimed stale worker-promotion admission stop' <<< "$output"
  elif [ -n "$existing_stop" ]; then
    [ "$(cat "$case_dir/admission-stop")" = "$existing_stop" ]
    grep -Fq 'Existing scan admission stop preserved' <<< "$output"
  else
    [ ! -s "$case_dir/admission-stop" ]
  fi

  if [ "$restart_fails" = 1 ]; then
    # The restart failure must carry the unit's own state and journal tail into
    # the CI log, and both must be captured before the rollback trap runs.
    grep -Fq 'MOCK worker unit status' <<< "$output"
    grep -Fq 'MOCK worker journal tail' <<< "$output"
    grep -Fxq -- 'status --no-pager lyrashield-worker.service' "$case_dir/systemctl.log"
    grep -Fxq -- '-u lyrashield-worker.service -n 50 --no-pager' "$case_dir/journalctl.log"
    rollback_line=$(grep -Fn 'Worker promotion failed during:' <<< "$output" | head -n 1 | cut -d: -f1)
    status_line=$(grep -Fn 'MOCK worker unit status' <<< "$output" | head -n 1 | cut -d: -f1)
    journal_line=$(grep -Fn 'MOCK worker journal tail' <<< "$output" | head -n 1 | cut -d: -f1)
    [ -n "$rollback_line" ] && [ -n "$status_line" ] && [ -n "$journal_line" ]
    [ "$status_line" -lt "$rollback_line" ]
    [ "$journal_line" -lt "$rollback_line" ]
  else
    [ ! -s "$case_dir/journalctl.log" ]
  fi
}

run_case healthy 1 1 1 success
run_case repairs-inactive-timer 0 1 1 success
run_case repairs-disabled-units 1 0 0 success
run_case repairs-inactive-service 1 1 1 success 0
run_case recovers-missing-container 1 1 1 success 0 '' 0 '' 9999999000 0
# No live container and no local rollback image: the preflight must still
# size the pull from the 8 GiB floor (required free = 26 GiB) rather than
# dying inside image inspection.
run_case missing-rollback-image 1 1 1 success 0 '' 0 '' 30000000000 0 0
# 3 GiB free would satisfy a measured-image preflight but not the 26 GiB
# floor, so the promotion must stop at the disk check.
run_case missing-rollback-tight-disk 1 1 1 failure 0 '' 0 '' 3000000000 0 0
# The floor is tunable: with LYRASHIELD_WORKER_IMAGE_FLOOR_BYTES=2147483648
# the required budget drops to 8 GiB, so 9 GiB of free space promotes where
# the 26 GiB default would stop.
run_case missing-rollback-tunable-floor 1 1 1 success 0 '' 0 '' 9663676416 0 0 2147483648
# Same override read from the runtime config when the env var is absent.
run_case missing-rollback-config-floor 1 1 1 success 0 '' 0 '' 9663676416 0 0 2147483648 config
# A malformed floor fails closed instead of silently falling back.
run_case missing-rollback-bad-floor 1 1 1 failure 0 '' 0 '' 9663676416 0 0 abc
run_case preserves-existing-stop 1 1 1 success 1 '{"operator":"on-call","reason":"evidence-kek-rotation"}'
run_case reclaims-stale-promotion-stop 1 1 1 success 1 '{"operator":"github-actions","reason":"worker-promotion","at":"2026-09-19T00:47:48.285Z"}'
run_case preserves-newer-stop 1 1 1 success 1 '' 0 '{"operator":"on-call","reason":"new-incident"}'
run_case resumes-owned-stop-on-rollback 1 1 1 failure 1 '' 1
run_case preserves-existing-stop-on-rollback 1 1 1 failure 1 '{"operator":"on-call","reason":"evidence-kek-rotation"}' 1
run_case rolls-back-maintenance-assets 1 1 1 failure 1 '' 0 '' 9999999000 1 1 '' env 1
run_case insufficient-disk 1 1 1 failure 1 '' 0 '' 1000

preflight_dir="$tmp/preflight"
write_mocks "$preflight_dir"
printf 1 > "$preflight_dir/service-active"
printf 1 > "$preflight_dir/container-present"
printf 1 > "$preflight_dir/timer-active"
printf 1 > "$preflight_dir/service-enabled"
printf 1 > "$preflight_dir/timer-enabled"
: > "$preflight_dir/admission-stop"
: > "$preflight_dir/docker.log"
: > "$preflight_dir/systemctl.log"
: > "$preflight_dir/order.log"
printf 'LYRASHIELD_WORKER_IMAGE=%s\nLYRASHIELD_SANDBOX_IMAGE=ghcr.io/example/sandbox@sha256:%s\n' "$old_image" "$(printf 'e%.0s' {1..64})" > "$preflight_dir/runtime.conf"
printf 'REDIS_URL=rediss://current@redis.test:6379\nDATABASE_URL=postgresql://current@database.test:5432/lyrashield\n' > "$preflight_dir/worker.env"
preflight_output=$(
  PATH="$preflight_dir/bin:$PATH" \
    MOCK_TARGET="$target" \
    MOCK_APP_REVISION="$app_revision" \
    MOCK_ENGINE_REVISION="$engine_revision" \
    MOCK_SERVICE_ACTIVE="$preflight_dir/service-active" \
    MOCK_CONTAINER_PRESENT="$preflight_dir/container-present" \
    MOCK_TIMER_ACTIVE="$preflight_dir/timer-active" \
    MOCK_SERVICE_ENABLED="$preflight_dir/service-enabled" \
    MOCK_TIMER_ENABLED="$preflight_dir/timer-enabled" \
    MOCK_ADMISSION_STOP="$preflight_dir/admission-stop" \
    MOCK_DOCKER_LOG="$preflight_dir/docker.log" \
    MOCK_SYSTEMCTL_LOG="$preflight_dir/systemctl.log" \
    MOCK_ORDER_LOG="$preflight_dir/order.log" \
    LYRASHIELD_WORKER_RUNTIME_CONFIG="$preflight_dir/runtime.conf" \
    LYRASHIELD_WORKER_ENV_FILE="$preflight_dir/worker.env" \
    LYRASHIELD_WORKER_HOST_LIBEXEC_DIR="$preflight_dir/host/libexec" \
    LYRASHIELD_WORKER_HOST_ASSETS_DIR="$preflight_dir/host/assets" \
    LYRASHIELD_WORKER_ENV_LIB="$repo/ops/worker/worker-env.sh" \
    sh "$script" --preflight
)
grep -Fq 'Worker empty-queue preflight passed' <<< "$preflight_output"
[ "$(grep -Fxc 'refresh-secrets' "$preflight_dir/order.log")" -eq 1 ]
[ ! -s "$preflight_dir/systemctl.log" ]

echo "Worker promotion systemd proof passed."
