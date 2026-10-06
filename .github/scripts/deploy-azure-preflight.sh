#!/usr/bin/env bash
set -euo pipefail

# Workflow step: Ensure app and scanner system identities
step_ensure-app-and-scanner-system-identities() {
  set -euo pipefail
  for container_app in "$AZURE_APP_CONTAINER_APP_NAME" "$AZURE_SCANNER_CONTAINER_APP_NAME"; do
    if [ -z "$container_app" ]; then
      continue
    fi
    az containerapp identity assign \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --system-assigned \
      --only-show-errors \
      --output none
    principal_id=$(az containerapp show \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --query identity.principalId \
      --output tsv)
    if [ -z "$principal_id" ] || [ "$principal_id" = "None" ]; then
      echo "::error::Could not confirm the system-assigned identity for ${container_app}."
      exit 1
    fi
    echo "Confirmed system-assigned identity for ${container_app}."
  done
}

# Workflow step: Prepare private registry and zero-downtime rollout
verify_egress_proxy_key_vault_access() {
  if [ -z "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" ]; then
    return 0
  fi

  local principal_id vault_id role_count secret_ref secret_identity
  principal_id=$(az containerapp show \
    --name "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --query identity.principalId \
    --output tsv)
  if [ -z "$principal_id" ] || [ "$principal_id" = "None" ]; then
    echo "::error::${AZURE_EGRESS_PROXY_CONTAINER_APP_NAME} needs a system-assigned identity for its Key Vault secret."
    exit 1
  fi

  vault_id=$(az keyvault show --name "$AZURE_KEY_VAULT_NAME" --query id --output tsv)
  if [ -z "$vault_id" ] || [ "$vault_id" = "None" ]; then
    echo "::error::Could not resolve the egress proxy Key Vault resource ID."
    exit 1
  fi
  role_count=$(az role assignment list \
    --scope "${vault_id}/secrets/worker-egress-proxy-secret" \
    --include-inherited \
    --assignee-object-id "$principal_id" \
    --query "[?roleDefinitionName=='Key Vault Secrets User'] | length(@)" \
    --output tsv)
  if ! [[ "$role_count" =~ ^[0-9]+$ ]] || [ "$role_count" -lt 1 ]; then
    echo "::error::${AZURE_EGRESS_PROXY_CONTAINER_APP_NAME} needs Key Vault Secrets User on worker-egress-proxy-secret or an inherited scope before rollout."
    exit 1
  fi

  secret_ref=$(az containerapp show \
    --name "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --query "properties.configuration.secrets[?name=='egress-proxy-secret'] | [0].keyVaultUrl" \
    --output tsv)
  secret_identity=$(az containerapp show \
    --name "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --query "properties.configuration.secrets[?name=='egress-proxy-secret'] | [0].identity" \
    --output tsv)
  if [ "$secret_ref" != "https://${AZURE_KEY_VAULT_NAME}.vault.azure.net/secrets/worker-egress-proxy-secret" ] || [ "$secret_identity" != "system" ]; then
    echo "::error::${AZURE_EGRESS_PROXY_CONTAINER_APP_NAME} must reference worker-egress-proxy-secret through its system identity."
    exit 1
  fi
}

step_prepare-private-registry-and-zero-downtime-rollout() {
  verify_egress_proxy_key_vault_access
  GHCR_TOKEN=$(az keyvault secret show \
    --vault-name "$AZURE_KEY_VAULT_NAME" \
    --name ghcr-token \
    --query value \
    --output tsv)
  if [ -z "$GHCR_TOKEN" ]; then
    echo "::error::Key Vault secret ghcr-token is empty. Refusing to create revisions that cannot pull their images."
    exit 1
  fi
  echo "::add-mask::$GHCR_TOKEN"

  verify_manifest() {
    local image="$1"
    local digest="$2"
    local repository="${image#ghcr.io/}"
    repository="${repository%:*}"
    local registry_token
    registry_token=$(curl --fail --silent --show-error \
      --user "$GHCR_USERNAME:$GHCR_TOKEN" \
      --get \
      --data-urlencode 'service=ghcr.io' \
      --data-urlencode "scope=repository:${repository}:pull" \
      https://ghcr.io/token | jq -r '.token // empty')
    if [ -z "$registry_token" ]; then
      echo "::error::GHCR did not issue a pull token for ${repository}."
      exit 1
    fi
    curl --fail --silent --show-error --output /dev/null \
      --header "Authorization: Bearer ${registry_token}" \
      --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
      "https://ghcr.io/v2/${repository}/manifests/${digest}"
  }

  prepare_container_app() {
    local output_name="$1"
    local container_app="$2"
    if [ -z "$container_app" ]; then
      echo "${output_name}_previous=" >> "$GITHUB_OUTPUT"
      return 0
    fi

    az containerapp revision set-mode \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --mode multiple \
      --output none

    local previous_revision
    previous_revision=$(az containerapp ingress traffic show \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --query "[?weight == \`100\`] | [0].revisionName" \
      --output tsv)
    if [ -z "$previous_revision" ] || [ "$previous_revision" = "null" ]; then
      echo "::error::${container_app} must have exactly one 100% traffic revision to preserve."
      exit 1
    fi

    az containerapp registry set \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --server ghcr.io \
      --username "$GHCR_USERNAME" \
      --password "$GHCR_TOKEN" \
      --output none
    echo "${output_name}_previous=${previous_revision}" >> "$GITHUB_OUTPUT"
  }

  verify_manifest "$WEB_IMAGE" "$WEB_DIGEST"
  verify_manifest "$EGRESS_PROXY_IMAGE" "$EGRESS_PROXY_DIGEST"
  prepare_container_app app "$AZURE_APP_CONTAINER_APP_NAME"
  prepare_container_app scanner "$AZURE_SCANNER_CONTAINER_APP_NAME"
  prepare_container_app egress "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME"
  unset GHCR_TOKEN
}

# Workflow step: Run database migrations
step_run-database-migrations() {
  if [ -z "${DATABASE_URL}" ]; then
    echo "::error::DATABASE_DIRECT_URL secret is not set — refusing to deploy code against an unmigrated schema."
    exit 1
  fi
  pnpm --filter @lyrashield/db exec prisma migrate deploy
}

# Workflow step: Verify shared rate-limiting credentials
step_verify-shared-rate-limiting-credentials() {
  if [ -z "${UPSTASH_REDIS_REST_URL}" ] || [ -z "${UPSTASH_REDIS_REST_TOKEN}" ]; then
    echo "::error::UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set. Rate limiting would fall back to per-instance memory, so the effective limit becomes (limit x replica count) and scaling out weakens the control. These are the HTTPS REST credentials and are NOT interchangeable with REDIS_URL."
    exit 1
  fi
  echo "Shared rate-limiting credentials present."
}

# Workflow step: Verify BullMQ Redis credential
step_verify-bullmq-redis-credential() {
  if [ -z "${BULLMQ_REDIS_URL}" ]; then
    echo "::error::BULLMQ_REDIS_URL is not set. The app cannot enqueue production scans without the BullMQ TLS endpoint. This is separate from the Upstash HTTPS REST credentials used for rate limiting."
    exit 1
  fi
  node -e '
    const value = process.env.BULLMQ_REDIS_URL;
    let url;
    try { url = new URL(value); } catch { process.exit(1); }
    if (url.protocol !== "rediss:" || !url.hostname || !url.username || !url.password) process.exit(1);
  ' || {
    echo "::error::BULLMQ_REDIS_URL must be a valid authenticated rediss:// URL in production."
    exit 1
  }
  echo "BullMQ TLS Redis credential present."
}

# Workflow step: Sync BullMQ Redis secret to worker Key Vault
step_sync-bullmq-redis-secret-to-worker-key-vault() {
  set -euo pipefail
  if [ "$AZURE_KEY_VAULT_NAME" != "lyrashieldprodsecrets" ]; then
    echo "::error::The worker VM reads Key Vault lyrashieldprodsecrets; update its runtime configuration before changing AZURE_KEY_VAULT_NAME."
    exit 1
  fi
  source .github/scripts/azure_secret_set.sh
  azure_keyvault_sync_env_group "$AZURE_KEY_VAULT_NAME" worker-redis-url:BULLMQ_REDIS_URL
  echo "BullMQ Redis secret synced to worker Key Vault."
}

# Workflow step: Sync billing reconciliation credentials to worker Key Vault
step_sync-billing-reconciliation-credentials-to-worker-key-vault() {
  set -euo pipefail
  if [ "$AZURE_KEY_VAULT_NAME" != "lyrashieldprodsecrets" ]; then
    echo "::error::The worker VM reads Key Vault lyrashieldprodsecrets; update its runtime configuration before changing AZURE_KEY_VAULT_NAME."
    exit 1
  fi
  if [ -z "$POLAR_ENVIRONMENT" ] || [ -z "$POLAR_ACCESS_TOKEN" ] || \
    [ -z "$RAZORPAY_KEY_ID" ] || [ -z "$RAZORPAY_KEY_SECRET" ]; then
    echo "::error::Billing reconciliation provider configuration is incomplete."
    exit 1
  fi
  source .github/scripts/azure_secret_set.sh
  azure_keyvault_sync_env_group "$AZURE_KEY_VAULT_NAME" \
    worker-polar-environment:POLAR_ENVIRONMENT \
    worker-polar-access-token:POLAR_ACCESS_TOKEN \
    worker-razorpay-key-id:RAZORPAY_KEY_ID \
    worker-razorpay-key-secret:RAZORPAY_KEY_SECRET
  echo "Billing reconciliation credentials synced to worker Key Vault."
}

# Workflow step: Verify evidence envelope key
step_verify-evidence-envelope-key() {
  node packages/evidence-storage/scripts/validate-kek-config.mjs
  echo "version=${LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF##*/}" >> "$GITHUB_OUTPUT"
  echo "Evidence envelope key configuration present and valid."
}

# Workflow step: Sync evidence envelope key to app Container App
step_sync-evidence-envelope-key-to-app-container-app() {
  source .github/scripts/azure_secret_set.sh
  set -euo pipefail
  if [ -z "$AZURE_APP_CONTAINER_APP_NAME" ]; then
    exit 0
  fi
  if [ -z "$AZURE_APP_SECRET_KEY_VAULT_NAME" ] || \
     [ "${AZURE_APP_SECRET_KEY_VAULT_NAME,,}" = "${AZURE_KEY_VAULT_NAME,,}" ]; then
    echo "::error::AZURE_APP_SECRET_KEY_VAULT_NAME must name an app-only Key Vault distinct from the worker vault."
    exit 1
  fi
  active_name="ev-kek-${LYRASHIELD_EVIDENCE_KEK_ACTIVE_REF##*/}"
  keyring_digest=$(printf '%s' "$LYRASHIELD_EVIDENCE_KEK_KEYRING" | sha256sum | cut -c1-12)
  keyring_name="ev-ring-${keyring_digest}"
  if [ "${#active_name}" -gt 20 ] || [ "${#keyring_name}" -gt 20 ]; then
    echo "::error::Derived evidence secret name exceeds the Container Apps 20-character limit."
    exit 1
  fi
  echo "active_name=${active_name}" >> "$GITHUB_OUTPUT"
  echo "keyring_name=${keyring_name}" >> "$GITHUB_OUTPUT"
  azure_keyvault_sync_env_group "$AZURE_APP_SECRET_KEY_VAULT_NAME" \
    "${active_name}:LYRASHIELD_EVIDENCE_KEK" \
    "${keyring_name}:LYRASHIELD_EVIDENCE_KEK_KEYRING"
  azure_keyvault_require_containerapp_access "$AZURE_APP_SECRET_KEY_VAULT_NAME" "$AZURE_RESOURCE_GROUP" "$AZURE_APP_CONTAINER_APP_NAME"
  app_vault_base="https://${AZURE_APP_SECRET_KEY_VAULT_NAME}.vault.azure.net/secrets"
  sync_secret_group "$AZURE_APP_CONTAINER_APP_NAME" \
    "${active_name}=keyvaultref:${app_vault_base}/${active_name},identityref:system" \
    "${keyring_name}=keyvaultref:${app_vault_base}/${keyring_name},identityref:system"
}

# Workflow step: Sync evidence storage credentials to app Container App
step_sync-evidence-storage-credentials-to-app-container-app() {
  if [ -z "$AZURE_APP_CONTAINER_APP_NAME" ]; then
    exit 0
  fi
  source .github/scripts/azure_secret_set.sh

  vault_base="https://${AZURE_KEY_VAULT_NAME}.vault.azure.net/secrets"

  azure_containerapp_secret_set_retrying \
    --name "$AZURE_APP_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --secrets \
      "evidence-s3-endpoint=keyvaultref:${vault_base}/worker-r2-endpoint,identityref:system" \
      "evidence-s3-bucket=keyvaultref:${vault_base}/worker-r2-bucket,identityref:system" \
      "evidence-s3-access=keyvaultref:${vault_base}/worker-r2-access-key,identityref:system" \
      "evidence-s3-secret=keyvaultref:${vault_base}/worker-r2-secret-key,identityref:system" \
    --output none
  echo "Evidence storage Key Vault references synced to the app Container App."
}

# Workflow step: Sync IP hash salt Key Vault reference
step_sync-ip-hash-salt-key-vault-reference() {
  set -euo pipefail
  if [ -z "$AZURE_APP_CONTAINER_APP_NAME" ]; then
    echo "::error::The app Container App is required to sync IP_HASH_SALT."
    exit 1
  fi
  secret_name=$(az keyvault secret list \
    --vault-name "$AZURE_KEY_VAULT_NAME" \
    --query "[?name=='ip-hash-salt' && attributes.enabled].name | [0]" \
    --output tsv)
  if [ "$secret_name" != "ip-hash-salt" ]; then
    echo "::error::The enabled ip-hash-salt Key Vault secret is missing or unavailable."
    exit 1
  fi

  vault_id=$(az keyvault show \
    --name "$AZURE_KEY_VAULT_NAME" \
    --query id \
    --output tsv)
  if [ -z "$vault_id" ] || [ "$vault_id" = "None" ]; then
    echo "::error::Could not resolve the Key Vault resource ID for the IP hash salt access check."
    exit 1
  fi
  secret_scope="${vault_id}/secrets/ip-hash-salt"
  for container_app in "$AZURE_APP_CONTAINER_APP_NAME" "$AZURE_SCANNER_CONTAINER_APP_NAME"; do
    if [ -z "$container_app" ]; then
      continue
    fi
    principal_id=$(az containerapp show \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --query identity.principalId \
      --output tsv)
    if [ -z "$principal_id" ] || [ "$principal_id" = "None" ]; then
      echo "::error::${container_app} has no system-assigned identity for the IP hash salt reference."
      exit 1
    fi
    role_count=$(az role assignment list \
      --scope "$secret_scope" \
      --include-inherited \
      --assignee-object-id "$principal_id" \
      --query "[?roleDefinitionName=='Key Vault Secrets User'] | length(@)" \
      --output tsv)
    if ! [[ "$role_count" =~ ^[0-9]+$ ]] || [ "$role_count" -lt 1 ]; then
      echo "::error::${container_app} requires a one-time Key Vault Secrets User grant at the ip-hash-salt secret scope or an inherited scope. Provision the required role assignment separately; this deployment identity cannot create role assignments."
      exit 1
    fi
  done

  # BullMQ Redis credentials are stored in the worker-readable vault,
  # but each Container App resolves the same URI via its own identity.
  # Grant only secret-scoped access to this single secret.
  for container_app in "$AZURE_APP_CONTAINER_APP_NAME" "$AZURE_SCANNER_CONTAINER_APP_NAME"; do
    if [ -z "$container_app" ]; then
      continue
    fi
    principal_id=$(az containerapp show \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --query identity.principalId \
      --output tsv)
    redis_scope="${vault_id}/secrets/worker-redis-url"
    role_count=$(az role assignment list \
      --scope "$redis_scope" \
      --include-inherited \
      --assignee-object-id "$principal_id" \
      --query "[?roleDefinitionName=='Key Vault Secrets User'] | length(@)" \
      --output tsv)
    if ! [[ "$role_count" =~ ^[0-9]+$ ]] || [ "$role_count" -lt 1 ]; then
      echo "::error::${container_app} requires Key Vault Secrets User access to worker-redis-url or an inherited scope. Provision the required role assignment separately; this deployment identity cannot create role assignments."
      exit 1
    fi
  done

  if [ -n "$AZURE_APP_CONTAINER_APP_NAME" ]; then
    app_principal_id=$(az containerapp show \
      --name "$AZURE_APP_CONTAINER_APP_NAME" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --query identity.principalId \
      --output tsv)
    for secret_name in worker-polar-access-token worker-razorpay-key-id worker-razorpay-key-secret; do
      provider_secret_scope="${vault_id}/secrets/${secret_name}"
      role_count=$(az role assignment list \
        --scope "$provider_secret_scope" \
        --include-inherited \
        --assignee-object-id "$app_principal_id" \
        --query "[?roleDefinitionName=='Key Vault Secrets User'] | length(@)" \
        --output tsv)
      if ! [[ "$role_count" =~ ^[0-9]+$ ]] || [ "$role_count" -lt 1 ]; then
        echo "::error::${AZURE_APP_CONTAINER_APP_NAME} requires Key Vault Secrets User access to ${secret_name} or an inherited scope. Provision the required role assignment separately; this deployment identity cannot create role assignments."
        exit 1
      fi
    done
  fi

  source .github/scripts/azure_secret_set.sh
  vault_secret_ref="keyvaultref:https://${AZURE_KEY_VAULT_NAME}.vault.azure.net/secrets/ip-hash-salt,identityref:system"
  for container_app in "$AZURE_APP_CONTAINER_APP_NAME" "$AZURE_SCANNER_CONTAINER_APP_NAME"; do
    if [ -z "$container_app" ]; then
      continue
    fi
    azure_containerapp_secret_set_retrying \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --secrets "ip-hash-salt=${vault_secret_ref}" \
      --output none
  done
  echo "IP hash salt Key Vault references synced using metadata-only secret listing."
}

# Workflow step: Sync Myra secrets to app Container App
step_sync-myra-secrets-to-app-container-app() {
  source .github/scripts/azure_secret_set.sh
  set -euo pipefail
  if [ -z "$AZURE_APP_CONTAINER_APP_NAME" ]; then
    exit 0
  fi
  mappings=()
  [ -z "$MYRA_AZURE_OPENAI_API_KEY" ] || mappings+=("myra-aoai-key:MYRA_AZURE_OPENAI_API_KEY")
  [ -z "$TURNSTILE_SECRET_KEY" ] || mappings+=("turnstile-secret:TURNSTILE_SECRET_KEY")
  [ -z "$MYRA_GOOGLE_CLIENT_SECRET" ] || mappings+=("myra-g-secret:MYRA_GOOGLE_CLIENT_SECRET")
  [ -z "$MYRA_GOOGLE_REFRESH_TOKEN" ] || mappings+=("myra-g-refresh:MYRA_GOOGLE_REFRESH_TOKEN")
  if [ "${#mappings[@]}" -eq 0 ]; then
    echo "No optional Myra secrets are configured."
    exit 0
  fi
  if [ -z "$AZURE_APP_SECRET_KEY_VAULT_NAME" ] || \
     [ "${AZURE_APP_SECRET_KEY_VAULT_NAME,,}" = "${AZURE_KEY_VAULT_NAME,,}" ]; then
    echo "::error::AZURE_APP_SECRET_KEY_VAULT_NAME must name an app-only Key Vault distinct from the worker vault."
    exit 1
  fi
  azure_keyvault_sync_env_group "$AZURE_APP_SECRET_KEY_VAULT_NAME" "${mappings[@]}"
  azure_keyvault_require_containerapp_access "$AZURE_APP_SECRET_KEY_VAULT_NAME" "$AZURE_RESOURCE_GROUP" "$AZURE_APP_CONTAINER_APP_NAME"
  app_vault_base="https://${AZURE_APP_SECRET_KEY_VAULT_NAME}.vault.azure.net/secrets"
  refs=()
  for mapping in "${mappings[@]}"; do
    secret_name="${mapping%%:*}"
    refs+=("${secret_name}=keyvaultref:${app_vault_base}/${secret_name},identityref:system")
  done
  sync_secret_group "$AZURE_APP_CONTAINER_APP_NAME" "${refs[@]}"
  echo "Myra secret Key Vault references synced to the app Container App."
}

# Workflow step: Sync Upstash secrets to Container Apps
step_sync-upstash-secrets-to-container-apps() {
  source .github/scripts/azure_secret_set.sh
  set -euo pipefail
  if [ -z "$AZURE_CONTAINER_APPS_SECRET_KEY_VAULT_NAME" ]; then
    echo "::error::AZURE_CONTAINER_APPS_SECRET_KEY_VAULT_NAME must name the shared app/scanner-only Key Vault for Upstash credentials."
    exit 1
  fi
  for other_vault in "$AZURE_KEY_VAULT_NAME" "$AZURE_APP_SECRET_KEY_VAULT_NAME"; do
    if [ -n "$other_vault" ] && [ "${AZURE_CONTAINER_APPS_SECRET_KEY_VAULT_NAME,,}" = "${other_vault,,}" ]; then
      echo "::error::The shared Container Apps vault must be distinct from the worker and app-only vaults."
      exit 1
    fi
  done
  apps=()
  [ -z "$AZURE_APP_CONTAINER_APP_NAME" ] || apps+=("$AZURE_APP_CONTAINER_APP_NAME")
  [ -z "$AZURE_SCANNER_CONTAINER_APP_NAME" ] || apps+=("$AZURE_SCANNER_CONTAINER_APP_NAME")
  if [ "${#apps[@]}" -eq 0 ]; then exit 0; fi
  azure_keyvault_sync_env_group "$AZURE_CONTAINER_APPS_SECRET_KEY_VAULT_NAME" \
    upstash-redis-rest-url:UPSTASH_REDIS_REST_URL \
    upstash-redis-rest-token:UPSTASH_REDIS_REST_TOKEN
  azure_keyvault_require_containerapp_access "$AZURE_CONTAINER_APPS_SECRET_KEY_VAULT_NAME" "$AZURE_RESOURCE_GROUP" "${apps[@]}"
  vault_base="https://${AZURE_CONTAINER_APPS_SECRET_KEY_VAULT_NAME}.vault.azure.net/secrets"
  for container_app in "${apps[@]}"; do
    sync_secret_group "$container_app" \
      "upstash-redis-rest-url=keyvaultref:${vault_base}/upstash-redis-rest-url,identityref:system" \
      "upstash-redis-rest-token=keyvaultref:${vault_base}/upstash-redis-rest-token,identityref:system"
  done
}

# Workflow step: Sync the dedicated exact-result cache secrets to the worker Key Vault.
# The worker loads these values through refresh-secrets.sh; the cache stays off
# unless an operator explicitly selects observe/enforce.
step_sync-ai-result-cache-secrets-to-worker-key-vault() {
  source .github/scripts/azure_secret_set.sh
  set -euo pipefail
  local mode="${LYRASHIELD_AI_RESULT_CACHE_MODE:-off}"
  case "$mode" in
    off)
      ;;
    observe|enforce) ;;
    *) echo "::error::LYRASHIELD_AI_RESULT_CACHE_MODE must be off, observe, or enforce."; return 1 ;;
  esac
  if [ "${AZURE_KEY_VAULT_NAME:-}" != "lyrashieldprodsecrets" ]; then
    echo "::error::The worker VM reads Key Vault lyrashieldprodsecrets; update its runtime configuration before changing AZURE_KEY_VAULT_NAME."
    return 1
  fi
  if [ "$mode" != "off" ] && ! node <<'NODE'
const cacheRaw = process.env.LYRASHIELD_AI_CACHE_REDIS_URL || "";
const cacheKey = process.env.LYRASHIELD_AI_CACHE_KEY_SECRET || "";
const fingerprint = process.env.LYRASHIELD_AI_CACHE_PROVIDER_FINGERPRINT || "";
function host(value, protocols) {
  if (!value) throw new Error("queue and rate-limit Redis endpoints are required for isolation checks");
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) throw new Error("invalid endpoint protocol");
  return url.hostname.toLowerCase();
}
try {
  const cache = new URL(cacheRaw);
  if (cache.protocol !== "rediss:" || !cache.hostname || !cache.username || !cache.password)
    throw new Error("cache endpoint must be credentialed TLS Redis");
  if (Buffer.byteLength(cacheKey, "utf8") < 32) throw new Error("cache key must contain at least 32 bytes");
  if (!/^[a-fA-F0-9]{64}$/.test(fingerprint)) throw new Error("provider fingerprint must be SHA-256");
  const cacheHost = cache.hostname.toLowerCase();
  if (host(process.env.BULLMQ_REDIS_URL, ["redis:", "rediss:"]) === cacheHost)
    throw new Error("cache Redis host must be separate from BullMQ");
  if (host(process.env.UPSTASH_REDIS_REST_URL, ["https:"]) === cacheHost)
    throw new Error("cache Redis host must be separate from rate-limit Redis");
} catch (error) {
  process.stderr.write(`Invalid exact AI-result cache configuration: ${error.message}.\n`);
  process.exit(1);
}
NODE
  then
    return 1
  fi
  local mappings=(worker-ai-result-cache-mode:LYRASHIELD_AI_RESULT_CACHE_MODE)
  if [ "$mode" != "off" ]; then
    mappings+=(
      worker-ai-cache-fingerprint:LYRASHIELD_AI_CACHE_PROVIDER_FINGERPRINT
      worker-ai-cache-url:LYRASHIELD_AI_CACHE_REDIS_URL
      worker-ai-cache-key:LYRASHIELD_AI_CACHE_KEY_SECRET
    )
  fi
  azure_keyvault_sync_env_group "$AZURE_KEY_VAULT_NAME" "${mappings[@]}"
  echo "Exact AI-result cache configuration synced to the worker Key Vault."
}

# Workflow step: Sync BullMQ Redis secret to Container Apps
step_sync-bullmq-redis-secret-to-container-apps() {
  source .github/scripts/azure_secret_set.sh
  set -euo pipefail
  apps=()
  [ -z "$AZURE_APP_CONTAINER_APP_NAME" ] || apps+=("$AZURE_APP_CONTAINER_APP_NAME")
  [ -z "$AZURE_SCANNER_CONTAINER_APP_NAME" ] || apps+=("$AZURE_SCANNER_CONTAINER_APP_NAME")
  if [ "${#apps[@]}" -eq 0 ]; then exit 0; fi
  vault_base="https://${AZURE_KEY_VAULT_NAME}.vault.azure.net/secrets"
  for container_app in "${apps[@]}"; do
    sync_secret_group "$container_app" \
      "bullmq-redis-url=keyvaultref:${vault_base}/worker-redis-url,identityref:system"
  done
}

# Workflow step: Sync billing provider secrets to app Container App
step_sync-billing-provider-secrets-to-app-container-app() {
  source .github/scripts/azure_secret_set.sh
  set -euo pipefail
  if [ -z "$AZURE_APP_SECRET_KEY_VAULT_NAME" ]; then
    echo "::error::AZURE_APP_SECRET_KEY_VAULT_NAME must name the dedicated app-only Key Vault."
    exit 1
  fi
  if [ "${AZURE_APP_SECRET_KEY_VAULT_NAME,,}" = "${AZURE_KEY_VAULT_NAME,,}" ]; then
    echo "::error::The app-only webhook vault must differ from the worker-readable Key Vault."
    exit 1
  fi
  if [ -z "$POLAR_WEBHOOK_SECRET" ] || [ -z "$RAZORPAY_WEBHOOK_SECRET" ]; then
    echo "::error::Billing provider webhook configuration is incomplete."
    exit 1
  fi
  azure_keyvault_sync_env_group "$AZURE_APP_SECRET_KEY_VAULT_NAME" \
    polar-webhook-secret:POLAR_WEBHOOK_SECRET \
    razorpay-webhook-secret:RAZORPAY_WEBHOOK_SECRET
  azure_keyvault_require_containerapp_access "$AZURE_APP_SECRET_KEY_VAULT_NAME" "$AZURE_RESOURCE_GROUP" "$AZURE_APP_CONTAINER_APP_NAME"
  app_vault_base="https://${AZURE_APP_SECRET_KEY_VAULT_NAME}.vault.azure.net/secrets"
  worker_vault_base="https://${AZURE_KEY_VAULT_NAME}.vault.azure.net/secrets"
  if ! sync_secret_group "$AZURE_APP_CONTAINER_APP_NAME" \
    "polar-access-token=keyvaultref:${worker_vault_base}/worker-polar-access-token,identityref:system" \
    "polar-webhook-secret=keyvaultref:${app_vault_base}/polar-webhook-secret,identityref:system" \
    "razorpay-key-id=keyvaultref:${worker_vault_base}/worker-razorpay-key-id,identityref:system" \
    "razorpay-key-secret=keyvaultref:${worker_vault_base}/worker-razorpay-key-secret,identityref:system" \
    "razorpay-webhook-secret=keyvaultref:${app_vault_base}/razorpay-webhook-secret,identityref:system"; then
    echo "::error::Failed to sync billing provider Key Vault references to ${AZURE_APP_CONTAINER_APP_NAME}."
    exit 1
  fi
}

# Workflow step: Verify email verification credentials
step_verify-email-verification-credentials() {
  if [ "$EMAIL_VERIFICATION_REQUIRED" != "1" ]; then
    exit 0
  fi
  verify_brevo_secret() {
    local container_app="$1"
    local secret_name
    secret_name=$(az containerapp secret list \
      --name "$container_app" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --query "[?name == 'brevo-api-key'].name | [0]" \
      --output tsv)
    if [ "$secret_name" != "brevo-api-key" ]; then
      echo "::error::${container_app} requires the pre-provisioned brevo-api-key Container App secret while email verification is enabled."
      exit 1
    fi
  }
  if [ -n "$AZURE_APP_CONTAINER_APP_NAME" ]; then
    verify_brevo_secret "$AZURE_APP_CONTAINER_APP_NAME"
  fi
  if [ -n "$AZURE_SCANNER_CONTAINER_APP_NAME" ]; then
    verify_brevo_secret "$AZURE_SCANNER_CONTAINER_APP_NAME"
  fi
}

# Workflow step: Verify GitHub App credentials
step_verify-github-app-credentials() {
  if [ -z "${GITHUB_APP_ID}" ] || [ -z "${GITHUB_APP_SLUG}" ] || [ -z "${GITHUB_APP_PRIVATE_KEY}" ] || [ -z "${GITHUB_WEBHOOK_SECRET}" ]; then
    echo "::warning::GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET are not all set. GitHub connect path will 500 CONFIG_ERROR until they are. F1's four-way onboarding (URL/API/Skip) keeps signups alive in the meantime."
  else
    if ! echo "${GITHUB_APP_PRIVATE_KEY}" | grep -q "BEGIN"; then
      echo "::error::GITHUB_APP_PRIVATE_KEY must be a PEM-formatted key starting with -----BEGIN."
      exit 1
    fi
    echo "GitHub App credentials present."
  fi
  # OAuth client credentials are a separate, independently-optional group:
  # they are only needed to ownership-verify a FIRST-TIME install. Absent
  # them the callback fails closed (github=verification_required) while
  # already-connected workspaces keep working, so this warns and never
  # blocks a deploy.
  if [ -z "${GITHUB_APP_CLIENT_ID}" ] || [ -z "${GITHUB_APP_CLIENT_SECRET}" ]; then
    echo "::warning::GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET are not set. No new workspace can complete a GitHub install — the callback cannot verify installation ownership and fails closed."
  else
    echo "GitHub App OAuth credentials present."
  fi
}

# Workflow step: Sync GitHub App secrets to app Container App
step_sync-github-app-secrets-to-app-container-app() {
  source .github/scripts/azure_secret_set.sh
  set -euo pipefail
  if [ -z "${GITHUB_APP_ID}" ] || [ -z "${GITHUB_APP_SLUG}" ] || [ -z "${GITHUB_APP_PRIVATE_KEY}" ] || [ -z "${GITHUB_WEBHOOK_SECRET}" ]; then
    echo "Skipping GitHub App secret sync — not all secrets set (see verify step above)."
    exit 0
  fi
  if [ -z "$AZURE_APP_CONTAINER_APP_NAME" ]; then exit 0; fi
  if [ -z "$AZURE_APP_SECRET_KEY_VAULT_NAME" ] || \
     [ "${AZURE_APP_SECRET_KEY_VAULT_NAME,,}" = "${AZURE_KEY_VAULT_NAME,,}" ]; then
    echo "::error::AZURE_APP_SECRET_KEY_VAULT_NAME must name an app-only Key Vault distinct from the worker vault."
    exit 1
  fi
  mappings=(
    github-app-id:GITHUB_APP_ID
    github-app-slug:GITHUB_APP_SLUG
    github-app-private-key:GITHUB_APP_PRIVATE_KEY
    github-webhook-secret:GITHUB_WEBHOOK_SECRET
  )
  if [ -n "${GITHUB_APP_CLIENT_ID}" ] && [ -n "${GITHUB_APP_CLIENT_SECRET}" ]; then
    mappings+=(github-app-client-id:GITHUB_APP_CLIENT_ID github-app-client-secret:GITHUB_APP_CLIENT_SECRET)
  fi
  azure_keyvault_sync_env_group "$AZURE_APP_SECRET_KEY_VAULT_NAME" "${mappings[@]}"
  azure_keyvault_require_containerapp_access "$AZURE_APP_SECRET_KEY_VAULT_NAME" "$AZURE_RESOURCE_GROUP" "$AZURE_APP_CONTAINER_APP_NAME"
  app_vault_base="https://${AZURE_APP_SECRET_KEY_VAULT_NAME}.vault.azure.net/secrets"
  refs=()
  for mapping in "${mappings[@]}"; do
    secret_name="${mapping%%:*}"
    refs+=("${secret_name}=keyvaultref:${app_vault_base}/${secret_name},identityref:system")
  done
  sync_secret_group "$AZURE_APP_CONTAINER_APP_NAME" "${refs[@]}"
  echo "GitHub App Key Vault references synced to the app Container App."
}

step="${1:-}"
case "$step" in
  ensure-app-and-scanner-system-identities) step_ensure-app-and-scanner-system-identities ;;
  verify-egress-proxy-key-vault-access) verify_egress_proxy_key_vault_access ;;
  prepare-private-registry-and-zero-downtime-rollout) step_prepare-private-registry-and-zero-downtime-rollout ;;
  run-database-migrations) step_run-database-migrations ;;
  verify-shared-rate-limiting-credentials) step_verify-shared-rate-limiting-credentials ;;
  verify-bullmq-redis-credential) step_verify-bullmq-redis-credential ;;
  sync-bullmq-redis-secret-to-worker-key-vault) step_sync-bullmq-redis-secret-to-worker-key-vault ;;
  sync-billing-reconciliation-credentials-to-worker-key-vault) step_sync-billing-reconciliation-credentials-to-worker-key-vault ;;
  verify-evidence-envelope-key) step_verify-evidence-envelope-key ;;
  sync-evidence-envelope-key-to-app-container-app) step_sync-evidence-envelope-key-to-app-container-app ;;
  sync-evidence-storage-credentials-to-app-container-app) step_sync-evidence-storage-credentials-to-app-container-app ;;
  sync-ip-hash-salt-key-vault-reference) step_sync-ip-hash-salt-key-vault-reference ;;
  sync-myra-secrets-to-app-container-app) step_sync-myra-secrets-to-app-container-app ;;
  sync-upstash-secrets-to-container-apps) step_sync-upstash-secrets-to-container-apps ;;
  sync-ai-result-cache-secrets-to-worker-key-vault) step_sync-ai-result-cache-secrets-to-worker-key-vault ;;
  sync-bullmq-redis-secret-to-container-apps) step_sync-bullmq-redis-secret-to-container-apps ;;
  sync-billing-provider-secrets-to-app-container-app) step_sync-billing-provider-secrets-to-app-container-app ;;
  verify-email-verification-credentials) step_verify-email-verification-credentials ;;
  verify-github-app-credentials) step_verify-github-app-credentials ;;
  sync-github-app-secrets-to-app-container-app) step_sync-github-app-secrets-to-app-container-app ;;
  *) echo "Unknown deploy Azure preflight step: ${step}" >&2; exit 2 ;;
esac
