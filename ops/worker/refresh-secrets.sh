#!/bin/sh
set -eu

umask 077

vault_name="${LYRASHIELD_KEY_VAULT_NAME:-lyrashieldprodsecrets}"
environment_file="${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}"
environment_dir=$(dirname "$environment_file")
azure_config_dir="${AZURE_CONFIG_DIR:-/var/lib/lyrashield-azure}"

mkdir -p "$environment_dir" "$azure_config_dir"
chmod 700 "$environment_dir" "$azure_config_dir"

runtime_config="${LYRASHIELD_WORKER_RUNTIME_CONFIG:-/etc/lyrashield/worker-runtime.conf}"
if [ ! -r "$runtime_config" ]; then
  echo "Worker runtime configuration is unavailable: $runtime_config" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$runtime_config"
set +a

export AZURE_CONFIG_DIR="$azure_config_dir"
az login --identity --allow-no-subscriptions --output none >/dev/null

temporary_file=$(mktemp "${environment_file}.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

read_secret() {
  secret_name="$1"
  secret_value=$(az keyvault secret show \
    --vault-name "$vault_name" \
    --name "$secret_name" \
    --query value \
    --output tsv)

  if [ -z "$secret_value" ]; then
    echo "Required Key Vault secret is empty: $secret_name" >&2
    exit 1
  fi
  newline_count=$(printf '%s' "$secret_value" | tr -cd '\r\n' | wc -c | tr -d ' ')
  if [ "$newline_count" -ne 0 ]; then
    echo "Key Vault secret contains a newline: $secret_name" >&2
    exit 1
  fi
}

write_secret() {
  environment_name="$1"
  read_secret "$2"
  printf '%s=%s\n' "$environment_name" "$secret_value" >>"$temporary_file"
}

read_secret_optional() {
  secret_name="$1"
  secret_value=$(az keyvault secret show \
    --vault-name "$vault_name" \
    --name "$secret_name" \
    --query value \
    --output tsv 2>/dev/null) || true

  if [ -z "$secret_value" ]; then
    return 0
  fi
  newline_count=$(printf '%s' "$secret_value" | tr -cd '\r\n' | wc -c | tr -d ' ')
  if [ "$newline_count" -ne 0 ]; then
    echo "Key Vault secret contains a newline: $secret_name" >&2
    exit 1
  fi
}

write_secret_optional() {
  environment_name="$1"
  read_secret_optional "$2"
  if [ -z "$secret_value" ]; then
    return 0
  fi
  printf '%s=%s\n' "$environment_name" "$secret_value" >>"$temporary_file"
}

write_secret DATABASE_URL worker-database-url
write_secret DATABASE_SYSTEM_URL worker-database-system-url
write_secret REDIS_URL worker-redis-url
write_secret BETTER_AUTH_SECRET worker-better-auth-secret
write_secret BETTER_AUTH_URL worker-better-auth-url
write_secret NEXT_PUBLIC_APP_URL worker-next-public-app-url
write_secret TRUSTED_PROXY_IP_HEADER worker-trusted-proxy-header
write_secret LYRASHIELD_LLM worker-lyrashield-llm
write_secret LYRASHIELD_LUNA_LLM worker-lyrashield-luna-llm
write_secret LYRASHIELD_TERRA_LLM worker-lyrashield-terra-llm
write_secret AZURE_AI_API_KEY worker-azure-ai-api-key
write_secret AZURE_AI_API_BASE worker-azure-ai-api-base
write_secret AZURE_API_VERSION worker-azure-api-version
write_secret S3_ENDPOINT worker-r2-endpoint
write_secret S3_BUCKET worker-r2-bucket
write_secret S3_ACCESS_KEY worker-r2-access-key
write_secret S3_SECRET_KEY worker-r2-secret-key
# Evidence envelope encryption key (base64, 32 bytes). Required together with
# the S3 block: evidence uploads fail closed without it. Generate once, store
# durably (loss makes envelope-encrypted evidence unreadable) — see
# packages/evidence-storage/scripts/generate-kek.mjs and PRODUCTION_DEPLOYMENT.
read_secret_optional worker-evidence-kek-config-ref
evidence_kek_config_ref=$secret_value
evidence_kek_keyring_secret_name=
evidence_kek_expected_keyring_digest=
if [ -n "$evidence_kek_config_ref" ]; then
  case "$evidence_kek_config_ref" in
    */*)
      evidence_kek_version=${evidence_kek_config_ref%%/*}
      evidence_kek_keyring_digest=${evidence_kek_config_ref#*/}
      ;;
    *)
      echo "Evidence KEK config ref is invalid" >&2
      exit 1
      ;;
  esac
  case "$evidence_kek_keyring_digest" in
    ''|*[!0-9a-f]*)
      echo "Evidence KEK config ref is invalid" >&2
      exit 1
      ;;
  esac
  if [ "${#evidence_kek_keyring_digest}" -ne 12 ]; then
    echo "Evidence KEK config ref is invalid" >&2
    exit 1
  fi
  evidence_kek_active_ref="envkeystore/lyrashield-evidence-kek/$evidence_kek_version"
  evidence_kek_secret_name="worker-evidence-kek-$evidence_kek_version"
  evidence_kek_keyring_secret_name="worker-evidence-kek-keyring-$evidence_kek_keyring_digest"
  evidence_kek_expected_keyring_digest=$evidence_kek_keyring_digest
else
  # Backward-compatible migration: ordinary refresh remains safe before the
  # immutable selector and its targets are provisioned. A present malformed
  # selector never falls back.
  read_secret_optional worker-evidence-kek-active-ref
  evidence_kek_active_ref=$secret_value
  if [ -n "$evidence_kek_active_ref" ]; then
    evidence_kek_prefix=envkeystore/lyrashield-evidence-kek/
    case "$evidence_kek_active_ref" in
      "${evidence_kek_prefix}"v*)
        evidence_kek_version=${evidence_kek_active_ref#"$evidence_kek_prefix"}
        ;;
      *)
        echo "Evidence KEK active ref is invalid" >&2
        exit 1
        ;;
    esac
    evidence_kek_secret_name="worker-evidence-kek-$evidence_kek_version"
    evidence_kek_keyring_secret_name="worker-evidence-kek-keyring-$evidence_kek_version"
  else
    evidence_kek_version=v1
    evidence_kek_active_ref=envkeystore/lyrashield-evidence-kek/v1
    evidence_kek_secret_name=worker-evidence-kek
  fi
fi
case "$evidence_kek_version" in
  v[1-9]*) evidence_kek_digits=${evidence_kek_version#v} ;;
  *)
    echo "Evidence KEK config ref is invalid" >&2
    exit 1
    ;;
esac
case "$evidence_kek_digits" in
  ''|*[!0-9]*)
    echo "Evidence KEK config ref is invalid" >&2
    exit 1
    ;;
esac
printf '%s=%s\n' LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF "$evidence_kek_active_ref" >>"$temporary_file"
write_secret LYRASHIELD_EVIDENCE_KEK "$evidence_kek_secret_name"
if [ -n "$evidence_kek_keyring_secret_name" ]; then
  write_secret LYRASHIELD_EVIDENCE_KEK_KEYRING "$evidence_kek_keyring_secret_name"
  if [ -n "$evidence_kek_expected_keyring_digest" ]; then
    evidence_kek_actual_keyring_digest=$(printf '%s' "$secret_value" | sha256sum | cut -c1-12)
    if [ "$evidence_kek_actual_keyring_digest" != "$evidence_kek_expected_keyring_digest" ]; then
      echo "Evidence KEK keyring digest does not match config ref" >&2
      exit 1
    fi
  fi
else
  printf '%s=%s\n' LYRASHIELD_EVIDENCE_KEK_KEYRING '{}' >>"$temporary_file"
fi
# Production URL scans fail closed without the authenticated proxy. Requiring
# both credentials here keeps a misconfigured worker out of service instead of
# accepting jobs it cannot safely execute.
write_secret LYRASHIELD_EGRESS_PROXY_URL worker-egress-proxy-url
write_secret LYRASHIELD_EGRESS_PROXY_SECRET worker-egress-proxy-secret
# Optional. When present and LYRASHIELD_WEB_SEARCH_ENABLED=1, enables Parallel Search.
write_secret_optional LYRASHIELD_WEB_SEARCH_API_KEY worker-web-search-api-key
# Optional paid-scan overlay. The worker defaults to disabled when these are
# absent, while a controlled production activation can use the existing Key
# Vault refresh path without adding a second configuration channel.
write_secret_optional LYRASHIELD_AI_TRIAGE_ENABLED worker-ai-triage-enabled
write_secret_optional LYRASHIELD_AI_TRIAGE_MAX_BUDGET_USD worker-ai-triage-max-budget-usd

uses_ghcr=false
for image in "${LYRASHIELD_WORKER_IMAGE:-}" "${LYRASHIELD_SANDBOX_IMAGE:-}"; do
  case "$image" in
    ghcr.io/*) uses_ghcr=true ;;
  esac
done
if [ "$uses_ghcr" = true ]; then
  write_secret GHCR_TOKEN ghcr-token
fi

printf '%s\n' 'S3_REGION=auto' >>"$temporary_file"

chmod 600 "$temporary_file"
mv -f "$temporary_file" "$environment_file"
trap - EXIT HUP INT TERM
