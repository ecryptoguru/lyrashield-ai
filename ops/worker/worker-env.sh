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

# Consumers word-split the emitted arguments, so every value must be
# whitespace-free. grep treats newlines as separators, so reject them first.
lwe_whitespace_free() {
  case "$1" in
    '') return 1 ;;
    *' '*) return 1 ;;
    *'
'*) return 1 ;;
  esac
  printf '%s' "$1" | LC_ALL=C grep -q '[^[:print:]]' && return 1
  return 0
}

lyrashield_worker_env_args() {
  lwe_config=$1
  lwe_environment_file=$2
  lwe_shared_root=${3:-/var/lib/lyrashield/worker}

  unset LYRASHIELD_RUN_RECORD_V1_1 LYRASHIELD_PENDING_HTTP_EVIDENCE LLM_API_MODE DEDUPE_LLM_API_MODE
  unset LYRASHIELD_COLD_SINGLE_WORKER LYRASHIELD_COLD_DATABASE_EPOCH_SHA256
  unset LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH
  unset LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH \
    LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF \
    LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION \
    LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT
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

  # Cold profile authority comes only from the protected host configuration.
  # Override any env-file/process value so credentials cannot select this gate.
  case "${LYRASHIELD_COLD_SINGLE_WORKER:-0}" in
    0) printf '%s\n' "--env LYRASHIELD_COLD_SINGLE_WORKER=0" "--env LYRASHIELD_COLD_DATABASE_EPOCH_SHA256=" ;;
    1)
      case "${LYRASHIELD_COLD_DATABASE_EPOCH_SHA256:-}" in
        ''|*[!a-f0-9]*) echo "Cold worker requires the captured database epoch" >&2; return 1 ;;
      esac
      [ "${#LYRASHIELD_COLD_DATABASE_EPOCH_SHA256}" -eq 64 ] || return 1
      printf '%s\n' "--env LYRASHIELD_COLD_SINGLE_WORKER=1" \
        "--env LYRASHIELD_COLD_DATABASE_EPOCH_SHA256=$LYRASHIELD_COLD_DATABASE_EPOCH_SHA256"
      ;;
    *) echo "Invalid cold single-worker profile" >&2; return 1 ;;
  esac

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

  # The managed-signed held record is read through a fixed root-owned mount.
  # Inherited process values never supply this runtime configuration control.
  if [ -n "${LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH:-}" ]; then
    [ "$LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH" = /etc/lyrashield/sandbox-publication-record.json ] || {
      echo "Signed sandbox publication record must use the protected runtime path" >&2
      return 1
    }
    printf '%s\n' "--env LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH=$LYRASHIELD_SANDBOX_PUBLICATION_RECORD_PATH"
  else
    # Signed bounded SBOM coverage evidence for the pinned sandbox image.
    # runner-config.ts requires all eight values in production
    # (assertSandboxSbomCoverageVerified), so the worker cannot start without
    # them; fail here, before any consumer starts, with the same formats the
    # consumer enforces. The evidence files are provisioned by the operator
    # into the shared root; runtime.conf carries only paths and identity.
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH:?Set the verified attestation output path in the runtime configuration}"
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH:?Set the expected coverage predicate path in the runtime configuration}"
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO:?Set the SBOM coverage engine repository in the runtime configuration}"
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF:?Set the SBOM coverage source ref in the runtime configuration}"
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION:?Set the SBOM coverage engine revision in the runtime configuration}"
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION:?Set the SBOM coverage workflow revision in the runtime configuration}"
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID:?Set the SBOM coverage run ID in the runtime configuration}"
    : "${LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT:?Set the SBOM coverage run attempt in the runtime configuration}"
    for lwe_sbom_path in \
      "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH" \
      "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH"; do
      case "$lwe_sbom_path" in
        /*) ;;
        *) echo "SBOM coverage evidence paths must be absolute" >&2; return 1 ;;
      esac
      lwe_whitespace_free "$lwe_sbom_path" || {
        echo "SBOM coverage evidence paths must be whitespace-free" >&2
        return 1
      }
    done
    for lwe_sbom_value in \
      "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO" \
      "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF"; do
      lwe_whitespace_free "$lwe_sbom_value" || {
        echo "SBOM coverage evidence values must be whitespace-free" >&2
        return 1
      }
    done
    case "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF" in
      refs/*) ;;
      *) echo "SBOM coverage source ref must be fully qualified" >&2; return 1 ;;
    esac
    case "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO" in
      */*) ;;
      *) echo "SBOM coverage engine repository must be owner/name" >&2; return 1 ;;
    esac
    lwe_is_40_hex "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION" || {
      echo "SBOM coverage engine revision must be a 40-character SHA" >&2
      return 1
    }
    lwe_is_40_hex "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION" || {
      echo "SBOM coverage workflow revision must be a 40-character SHA" >&2
      return 1
    }
    for lwe_sbom_number in "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID" "$LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT"; do
      case "$lwe_sbom_number" in
        ''|*[!0-9]*|0*) echo "SBOM coverage run identity must be positive decimal" >&2; return 1 ;;
      esac
    done
    printf '%s\n' \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_VERIFY_PATH" \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_EXPECTED_PATH" \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_REPO" \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_REF" \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_ENGINE_REVISION" \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_WORKFLOW_REVISION" \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ID" \
      "--env LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT=$LYRASHIELD_SANDBOX_SBOM_COVERAGE_RUN_ATTEMPT"
  fi

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
