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
    printf 1 > "$MOCK_SERVICE_ACTIVE" ;;
  reset-failed:lyrashield-worker.service) ;;
  *) echo "unexpected systemctl call: $command $unit" >&2; exit 1 ;;
esac
MOCK

  cat > "$case_dir/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
case "$1:$2" in
  inspect:lyrashield-worker)
    case "$*" in
      *State.Health*) printf 'healthy\n' ;;
      *Config.Image*) printf '%s\n' "$MOCK_TARGET" ;;
      *) exit 1 ;;
    esac ;;
  exec:-w)
    case "$*" in
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
  image:inspect)
    case "$*" in
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
  cat > "$case_dir/bin/chown" <<'MOCK'
#!/bin/sh
exit 0
MOCK
  chmod +x "$case_dir/bin/"*
}

run_case() {
  local name=$1 timer_active=$2 service_enabled=$3 timer_enabled=$4 expected=$5
  local service_active=${6:-1}
  local case_dir="$tmp/$name"
  mkdir -p "$case_dir"
  write_mocks "$case_dir"
  printf '%s' "$service_active" > "$case_dir/service-active"
  printf '%s' "$timer_active" > "$case_dir/timer-active"
  printf '%s' "$service_enabled" > "$case_dir/service-enabled"
  printf '%s' "$timer_enabled" > "$case_dir/timer-enabled"
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
  fi
}

run_case healthy 1 1 1 success
run_case repairs-inactive-timer 0 1 1 success
run_case repairs-disabled-units 1 0 0 success
run_case repairs-inactive-service 1 1 1 success 0

echo "Worker promotion systemd proof passed."
