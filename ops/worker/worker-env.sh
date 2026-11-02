# shellcheck shell=sh
# Shared worker container environment. run-worker.sh sources this library to
# build the live worker's --env arguments and promote-worker-vm.sh sources it
# for the one-shot preflight and Redis eval containers, so every worker-image
# launch sees an identical environment surface.
#
# lyrashield_worker_env_args RUNTIME_CONFIG ENVIRONMENT_FILE [SHARED_ROOT]
# echoes the worker container's docker `--env` arguments, computed from the
# runtime configuration, the environment file and the worker image's OCI
# labels. Callers word-split the output into the docker argument list, so every
# emitted value must stay whitespace-free.

lwe_is_40_hex() {
  case "$1" in
    '' | *[!0-9a-fA-F]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

lwe_valid_api_mode() {
  case "$1" in
    auto|responses|chat_completions) return 0 ;;
    *) return 1 ;;
  esac
}

lyrashield_worker_env_args() {
  lwe_config=$1
  lwe_environment_file=$2
  lwe_shared_root=${3:-/var/lib/lyrashield/worker}

  unset LYRASHIELD_RUN_RECORD_V1_1 LYRASHIELD_PENDING_HTTP_EVIDENCE LLM_API_MODE DEDUPE_LLM_API_MODE
  set -a
  # shellcheck disable=SC1090
  . "$lwe_config"
  set +a

  : "${LYRASHIELD_WORKER_IMAGE:?Set an immutable worker image in the runtime configuration}"
  : "${LYRASHIELD_SANDBOX_IMAGE:?Set an immutable sandbox image in the runtime configuration}"
  : "${LYRASHIELD_SANDBOX_NETWORK:=lyrashield-sandbox}"

  # Worker execution provenance comes only from the immutable image reference
  # and its verified OCI labels; never accept manually typed revisions.
  lwe_worker_digest=${LYRASHIELD_WORKER_IMAGE##*@}
  lwe_app_revision=$(docker image inspect "$LYRASHIELD_WORKER_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
  lwe_engine_revision=$(docker image inspect "$LYRASHIELD_WORKER_IMAGE" --format '{{index .Config.Labels "io.lyrashield.engine.revision"}}')
  lwe_is_40_hex "$lwe_app_revision" || {
    echo "Worker image app revision label must be a 40-character SHA" >&2
    return 1
  }
  lwe_is_40_hex "$lwe_engine_revision" || {
    echo "Worker image engine revision label must be a 40-character SHA" >&2
    return 1
  }

  # Enable web search by default only when an API key is present in the worker env.
  if [ -z "${LYRASHIELD_WEB_SEARCH_ENABLED:-}" ]; then
    if [ -r "$lwe_environment_file" ] &&
      [ -n "$(sed -n 's/^LYRASHIELD_WEB_SEARCH_API_KEY=//p' "$lwe_environment_file" | head -n 1)" ]; then
      LYRASHIELD_WEB_SEARCH_ENABLED=1
    else
      LYRASHIELD_WEB_SEARCH_ENABLED=0
    fi
  fi

  # Only trusted runtime.conf controls may reach the word-split Docker argv.
  lwe_run_record=${LYRASHIELD_RUN_RECORD_V1_1-0}
  lwe_pending=${LYRASHIELD_PENDING_HTTP_EVIDENCE-0}
  case "$lwe_run_record/$lwe_pending" in
    0/0|1/0|1/1) ;;
    *) echo "Invalid worker evidence writer controls" >&2; return 1 ;;
  esac
  if [ "${LLM_API_MODE+x}" = x ] && ! lwe_valid_api_mode "$LLM_API_MODE"; then
    echo "Invalid worker LLM_API_MODE" >&2; return 1
  fi
  if [ "${DEDUPE_LLM_API_MODE+x}" = x ] && ! lwe_valid_api_mode "$DEDUPE_LLM_API_MODE"; then
    echo "Invalid worker DEDUPE_LLM_API_MODE" >&2; return 1
  fi
  if [ -n "${LLM_API_MODE-}" ]; then printf '%s\n' "--env LLM_API_MODE=$LLM_API_MODE"; fi
  if [ -n "${DEDUPE_LLM_API_MODE-}" ]; then printf '%s\n' "--env DEDUPE_LLM_API_MODE=$DEDUPE_LLM_API_MODE"; fi

  # Worker serves no authentication routes. Keep its email flag off so it does
  # not require the app's Brevo credential; app deployment defaults to on.
  printf '%s\n' \
    "--env LYRASHIELD_RUN_RECORD_V1_1=$lwe_run_record" \
    "--env LYRASHIELD_PENDING_HTTP_EVIDENCE=$lwe_pending" \
    "--env NODE_ENV=production" \
    "--env PLATFORM_ADMIN_EMAILS=ecryptoguru@gmail.com,ankit@lyrashieldai.com" \
    "--env LYRASHIELD_REQUIRE_EMAIL_VERIFICATION=0" \
    "--env LYRASHIELD_WORKER_CONCURRENCY=1" \
    "--env PLATFORM_MAX_SCAN_BUDGET_USD=50" \
    "--env LYRASHIELD_RUNTIME_BACKEND=docker" \
    "--env LYRASHIELD_ENGINE_PATH=/opt/lyrashield-venv/bin/lyrashield" \
    "--env LYRASHIELD_ENGINE_WORK_ROOT=$lwe_shared_root" \
    "--env TMPDIR=$lwe_shared_root/tmp" \
    "--env LYRASHIELD_ENGINE_SANDBOX_NETWORK=$LYRASHIELD_SANDBOX_NETWORK" \
    "--env LYRASHIELD_IMAGE=$LYRASHIELD_SANDBOX_IMAGE" \
    "--env LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST=${LYRASHIELD_ALLOW_LOCAL_SANDBOX_HOST:-0}" \
    "--env LYRASHIELD_TELEMETRY=0" \
    "--env LYRASHIELD_LOCAL_EVIDENCE_STORAGE=0" \
    "--env LYRASHIELD_WEB_SEARCH_ENABLED=${LYRASHIELD_WEB_SEARCH_ENABLED}" \
    "--env LYRASHIELD_WEB_SEARCH_PROVIDER=${LYRASHIELD_WEB_SEARCH_PROVIDER:-parallel}" \
    "--env LYRASHIELD_WEB_SEARCH_MODE=${LYRASHIELD_WEB_SEARCH_MODE:-turbo}" \
    "--env LYRASHIELD_WEB_SEARCH_MAX_RESULTS=${LYRASHIELD_WEB_SEARCH_MAX_RESULTS:-5}" \
    "--env LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL=${LYRASHIELD_WEB_SEARCH_MAX_CHARS_TOTAL:-4000}" \
    "--env LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN=${LYRASHIELD_WEB_SEARCH_MAX_CALLS_PER_SCAN:-50}" \
    "--env LYRASHIELD_WEB_SEARCH_BUDGET_USD=${LYRASHIELD_WEB_SEARCH_BUDGET_USD:-1.0}" \
    "--env LYRASHIELD_PRODUCT_REVISION=$lwe_app_revision" \
    "--env LYRASHIELD_WORKER_IMAGE_DIGEST=$lwe_worker_digest" \
    "--env LYRASHIELD_ENGINE_REVISION=$lwe_engine_revision"
}
