#!/bin/sh
set -eu

umask 077

vault_name="${LYRASHIELD_KEY_VAULT_NAME:-lyrashieldprodsecrets}"
environment_file="${LYRASHIELD_WORKER_ENV_FILE:-/etc/lyrashield/worker.env}"
environment_dir=$(dirname "$environment_file")
azure_config_dir="${AZURE_CONFIG_DIR:-/var/lib/lyrashield-azure}"

mkdir -p "$environment_dir" "$azure_config_dir"
chmod 700 "$environment_dir" "$azure_config_dir"

export AZURE_CONFIG_DIR="$azure_config_dir"
az login --identity --allow-no-subscriptions --output none >/dev/null

temporary_file=$(mktemp "${environment_file}.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

write_secret() {
  environment_name="$1"
  secret_name="$2"
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

  printf '%s=%s\n' "$environment_name" "$secret_value" >>"$temporary_file"
}

write_secret DATABASE_URL worker-database-url
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
printf '%s\n' 'S3_REGION=auto' >>"$temporary_file"

chmod 600 "$temporary_file"
mv -f "$temporary_file" "$environment_file"
trap - EXIT HUP INT TERM
