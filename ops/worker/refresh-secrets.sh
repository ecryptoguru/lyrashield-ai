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

# GitHub mint authority lives only in the app vault, with secret-scoped VM grants.
github_vault=${LYRASHIELD_GITHUB_CREDENTIAL_VAULT_NAME:-}
case "$github_vault" in
  ''|*[!A-Za-z0-9-]*) echo "Worker GitHub credential vault is missing or invalid" >&2; exit 1 ;;
esac
if [ "$(printf '%s' "$github_vault" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$vault_name" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "Worker GitHub credential vault must differ from the shared worker vault" >&2
  exit 1
fi

write_github_credentials() {
  # Keep multiline handling separate from the single-line secret loader. Never
  # emit Azure/OpenSSL diagnostics containing key material or put it in argv.
  github_id=$(az keyvault secret show --vault-name "$github_vault" --name worker-github-app-id --query value --output tsv 2>/dev/null) || {
    echo "Required worker GitHub App ID is unavailable" >&2; exit 1;
  }
  case "$github_id" in
    ''|*[!0-9]*) echo "Worker GitHub App ID must be numeric" >&2; exit 1 ;;
  esac
  github_pem=$(az keyvault secret show --vault-name "$github_vault" --name worker-github-app-private-key --query value --output tsv 2>/dev/null) || {
    echo "Required worker GitHub private key is unavailable" >&2; exit 1;
  }
  if [ -z "$github_pem" ] || [ "$(printf '%s' "$github_pem" | tr -cd '\r' | wc -c | tr -d ' ')" -ne 0 ]; then
    echo "Worker GitHub private key is empty or contains CR" >&2; exit 1
  fi
  # Construct public delimiters from the two supported unencrypted key kinds.
  rsa_key_kind='RSA PRIVATE KEY'
  pkcs8_key_kind='PRIVATE KEY'
  rsa_header="-----BEGIN $rsa_key_kind-----"
  pkcs8_header="-----BEGIN $pkcs8_key_kind-----"
  case "$github_pem" in
    "$rsa_header"*) footer="-----END $rsa_key_kind-----" ;;
    "$pkcs8_header"*) footer="-----END $pkcs8_key_kind-----" ;;
    *) echo "Worker GitHub private key must be an unencrypted PEM" >&2; exit 1 ;;
  esac
  case "$github_pem" in
    *"$footer") ;;
    *) echo "Worker GitHub private key has an invalid PEM footer" >&2; exit 1 ;;
  esac
  if ! printf '%s\n' "$github_pem" | openssl rsa -check -noout -passin pass: >/dev/null 2>&1; then
    echo "Worker GitHub private key is not a valid RSA PEM" >&2; exit 1
  fi
  printf 'GITHUB_APP_ID=%s\n' "$github_id" >>"$temporary_file"
  printf 'GITHUB_APP_PRIVATE_KEY=' >>"$temporary_file"
  printf '%s\n' "$github_pem" | awk 'BEGIN { ORS="" } { printf "%s\\n", $0 }' >>"$temporary_file"
  printf '\n' >>"$temporary_file"
}
write_github_credentials

write_secret DATABASE_URL worker-database-url
write_secret DATABASE_SYSTEM_URL worker-database-system-url
write_secret REDIS_URL worker-redis-url
write_secret BETTER_AUTH_SECRET worker-better-auth-secret
write_secret BETTER_AUTH_URL worker-better-auth-url
write_secret NEXT_PUBLIC_APP_URL worker-next-public-app-url
write_secret TRUSTED_PROXY_IP_HEADER worker-trusted-proxy-header
write_secret POLAR_ENVIRONMENT worker-polar-environment
write_secret POLAR_ACCESS_TOKEN worker-polar-access-token
write_secret RAZORPAY_KEY_ID worker-razorpay-key-id
write_secret RAZORPAY_KEY_SECRET worker-razorpay-key-secret
read_secret ip-hash-salt
if [ "${#secret_value}" -lt 32 ]; then
  echo "IP hash salt must contain at least 32 characters" >&2
  exit 1
fi
printf 'IP_HASH_SALT=%s\n' "$secret_value" >>"$temporary_file"
write_secret LYRASHIELD_LLM worker-lyrashield-llm
write_secret LYRASHIELD_LUNA_LLM worker-lyrashield-luna-llm
write_secret LYRASHIELD_SOL_LLM worker-lyrashield-sol-llm
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
# Explicit operator activation; absent optional configuration preserves ordinary scans.
read_secret_optional worker-target-relay-enabled
case "${secret_value:-0}" in
  0) ;;
  1)
    write_secret LYRASHIELD_TARGET_RELAY_URL worker-egress-proxy-url
    read_secret worker-relay-signing-secret
    if [ "${#secret_value}" -lt 32 ]; then
      echo "Relay signing secret must contain at least 32 characters" >&2
      exit 1
    fi
    printf 'LYRASHIELD_RELAY_SIGNING_SECRET=%s\n' "$secret_value" >>"$temporary_file"
    ;;
  *) echo "Worker target relay activation must be 0 or 1" >&2; exit 1 ;;
esac
# Optional. When present and LYRASHIELD_WEB_SEARCH_ENABLED=1, enables Parallel Search.
write_secret_optional LYRASHIELD_WEB_SEARCH_API_KEY worker-web-search-api-key
# Optional paid-scan overlay. The worker defaults to disabled when these are
# absent, while a controlled production activation can use the existing Key
# Vault refresh path without adding a second configuration channel.
write_secret_optional LYRASHIELD_AI_TRIAGE_ENABLED worker-ai-triage-enabled
write_secret_optional LYRASHIELD_AI_TRIAGE_MAX_BUDGET_USD worker-ai-triage-max-budget-usd
# Exact triage-result reuse uses a dedicated Redis instance. Its mode is
# persisted in the worker Key Vault so the worker and promotion preflight read
# the same setting; absent configuration remains off.
read_secret_optional worker-ai-result-cache-mode
cache_mode=${secret_value:-off}
case "$cache_mode" in
  off|observe|enforce) ;;
  *) echo "Worker exact AI-result cache mode is invalid" >&2; exit 1 ;;
esac
printf 'LYRASHIELD_AI_RESULT_CACHE_MODE=%s\n' "$cache_mode" >>"$temporary_file"
if [ "$cache_mode" != "off" ]; then
  write_secret LYRASHIELD_AI_CACHE_PROVIDER_FINGERPRINT worker-ai-cache-fingerprint
  case "$secret_value" in
    ''|*[!a-fA-F0-9]*) echo "Worker exact AI-result cache fingerprint is invalid" >&2; exit 1 ;;
  esac
  if [ "${#secret_value}" -ne 64 ]; then
    echo "Worker exact AI-result cache fingerprint is invalid" >&2
    exit 1
  fi
  write_secret LYRASHIELD_AI_CACHE_REDIS_URL worker-ai-cache-url
  case "$secret_value" in
    rediss://* ) ;;
    *) echo "Worker exact AI-result cache endpoint must use TLS Redis" >&2; exit 1 ;;
  esac
  write_secret LYRASHIELD_AI_CACHE_KEY_SECRET worker-ai-cache-key
  cache_key_bytes=$(printf '%s' "$secret_value" | wc -c | tr -d ' ')
  if [ "$cache_key_bytes" -lt 32 ]; then
    echo "Worker exact AI-result cache key must contain at least 32 bytes" >&2
    exit 1
  fi
fi

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
