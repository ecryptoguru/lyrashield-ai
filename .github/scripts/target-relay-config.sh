#!/usr/bin/env bash
# Metadata-only verification. Secret material is provisioned separately by the operator.
verify_target_relay_key_vault_access() {
  case "${TARGET_RELAY_ENABLED:-0}" in
    0) return 0 ;;
    1) ;;
    *) echo "::error::TARGET_RELAY_ENABLED must be 0 or 1."; return 1 ;;
  esac
  local principal_id vault_id role_count enabled
  principal_id=$(az containerapp show --name "$AZURE_EGRESS_PROXY_CONTAINER_APP_NAME" \
    --resource-group "$AZURE_RESOURCE_GROUP" --query identity.principalId --output tsv) || return 1
  [ -n "$principal_id" ] && [ "$principal_id" != None ] || return 1
  vault_id=$(az keyvault show --name "$AZURE_KEY_VAULT_NAME" --query id --output tsv) || return 1
  [ -n "$vault_id" ] && [ "$vault_id" != None ] || return 1
  role_count=$(az role assignment list --scope "${vault_id}/secrets/worker-relay-signing-secret" \
    --include-inherited --assignee-object-id "$principal_id" \
    --query "[?roleDefinitionName=='Key Vault Secrets User'] | length(@)" --output tsv) || return 1
  if ! [[ "$role_count" =~ ^[0-9]+$ ]] || [ "$role_count" -lt 1 ]; then
    echo "::error::The relay identity requires separately provisioned access to worker-relay-signing-secret."
    return 1
  fi
  enabled=$(az keyvault secret list-versions --vault-name "$AZURE_KEY_VAULT_NAME" \
    --name worker-relay-signing-secret \
    --query 'sort_by(@, &attributes.created)[-1].attributes.enabled' --output tsv) || return 1
  if [ "$enabled" != true ]; then
    echo "::error::The existing worker-relay-signing-secret must have an enabled latest version."
    return 1
  fi
}
