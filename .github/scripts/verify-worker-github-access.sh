#!/usr/bin/env bash
# Read-only: the deploy identity must not provision role assignments.
set -euo pipefail
vault=${AZURE_APP_SECRET_KEY_VAULT_NAME:?Set the existing app-only credential vault}
shared_vault=${AZURE_KEY_VAULT_NAME:?Set the ordinary worker vault}
[[ "$vault" =~ ^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$ && "$(printf '%s' "$vault" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$shared_vault" | tr '[:upper:]' '[:lower:]')" ]] || {
  echo '::error::Worker GitHub credentials require a distinct valid app-only vault.' >&2; exit 1;
}
vault_id=$(az keyvault show --name "$vault" --query id --output tsv)
rbac=$(az keyvault show --name "$vault" --query properties.enableRbacAuthorization --output tsv)
[[ "$vault_id" == /subscriptions/*/providers/Microsoft.KeyVault/vaults/* && "$rbac" = true ]] || {
  echo '::error::Worker credential vault must exist and use Azure RBAC.' >&2; exit 1;
}
identity_principals() {
  python3 -c '
import json, sys
identity = json.load(sys.stdin)
primary = identity.get("principalId")
if not isinstance(primary, str) or not primary or primary == "None": sys.exit(1)
print(primary)
for item in (identity.get("userAssignedIdentities") or {}).values():
    principal = item.get("principalId")
    if not isinstance(principal, str) or not principal or principal == "None": sys.exit(1)
    print(principal)
'
}
worker_identity=$(az vm show --name "${AZURE_WORKER_VM_NAME:?}" --resource-group "${AZURE_RESOURCE_GROUP:?}" --query identity --output json)
scanner_identity=$(az containerapp show --name "${AZURE_SCANNER_CONTAINER_APP_NAME:?}" --resource-group "$AZURE_RESOURCE_GROUP" --query identity --output json)
worker_principals=$(printf '%s' "$worker_identity" | identity_principals)
scanner_principals=$(printf '%s' "$scanner_identity" | identity_principals)
worker=$(printf '%s\n' "$worker_principals" | head -n 1)
if printf '%s\n' "$scanner_principals" | grep -Fqx "$worker"; then
  echo '::error::Worker and scanner must have distinct managed identities.' >&2; exit 1
fi
# --all finds descendant secret grants; the separate scoped query includes
# resource-group/subscription/management-group inheritance. Include group grants.
# Additional identities on either host must also remain excluded from this vault.
for principal in $worker_principals $scanner_principals; do
  all=$(az role assignment list --all --assignee-object-id "$principal" --include-groups --fill-principal-name false --output json)
  inherited=$(az role assignment list --scope "$vault_id" --include-inherited --assignee-object-id "$principal" --include-groups --fill-principal-name false --output json)
  mode=scanner
  [ "$principal" != "$worker" ] || mode=worker
  if ! printf '%s\n%s\n' "$all" "$inherited" | python3 -c '
import json, sys
vault, mode = sys.argv[1].lower(), sys.argv[2]
raw = sys.stdin.read()
decoder = json.JSONDecoder()
a, end = decoder.raw_decode(raw)
b = json.loads(raw[end:])
if not isinstance(a, list) or not isinstance(b, list): sys.exit(1)
expected = {vault + "/secrets/" + name for name in ("worker-github-app-id", "worker-github-app-private-key")}
found = set()
for row in a + b:
    scope = row.get("scope", "").lower().rstrip("/")
    if not scope: sys.exit(1)
    # Management-group assignments arrive only from the inherited query.
    relevant = scope == vault or scope.startswith(vault + "/") or vault.startswith(scope + "/") or scope.startswith("/providers/microsoft.management/managementgroups/")
    if not relevant: continue
    role = row.get("roleDefinitionId", "").lower().rsplit("/", 1)[-1]
    if mode != "worker" or scope not in expected or role != "4633458b-17de-408a-b874-0445c86b69e6" or row.get("condition"):
        sys.exit(1)
    found.add(scope)
if mode == "worker" and found != expected: sys.exit(1)
' "$vault_id" "$mode"; then
    echo "::error::Worker GitHub isolation check failed for ${mode}. An operator must grant only Key Vault Secrets User on ${vault_id}/secrets/worker-github-app-id and ${vault_id}/secrets/worker-github-app-private-key to VM identity ${worker}; remove broader app-vault or scanner grants. This deployment identity cannot create role assignments." >&2
    exit 1
  fi
done
echo 'Worker GitHub secret-scoped access and scanner exclusion verified.'
