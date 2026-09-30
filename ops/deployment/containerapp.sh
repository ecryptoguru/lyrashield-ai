#!/usr/bin/env bash
# Shared Azure Container Apps operations used by deploy-azure-runtime.yml.

ca_candidate() {
  local name="$1" resource_group="$2" revision fqdn
  revision=$(az containerapp show \
    --name "$name" \
    --resource-group "$resource_group" \
    --query properties.latestRevisionName \
    --output tsv)
  if [ -z "$revision" ] || [ "$revision" = "None" ]; then
    echo "::error::Azure did not return the candidate revision for ${name}." >&2
    return 1
  fi
  fqdn=$(az containerapp revision show \
    --name "$name" \
    --resource-group "$resource_group" \
    --revision "$revision" \
    --query properties.fqdn \
    --output tsv)
  if [ -z "$fqdn" ] || [ "$fqdn" = "None" ]; then
    echo "::error::Azure did not return the candidate FQDN for ${name}." >&2
    return 1
  fi
  printf '%s\t%s\n' "$revision" "$fqdn"
}

ca_client_cert_mode_get() {
  local resource_id="$1"
  az rest \
    --method get \
    --url "${resource_id}?api-version=2025-01-01" \
    --query 'properties.configuration.ingress.clientCertificateMode' \
    --output tsv
}

ca_client_cert_mode_set() {
  local resource_id="$1" mode="$2"
  case "$mode" in Ignore|Require) ;; *) echo "::error::Refusing an unexpected client certificate mode." >&2; return 2 ;; esac
  printf '%s' "$(jq -nc --arg mode "$mode" '{properties: {configuration: {ingress: {clientCertificateMode: $mode}}}}')" | az rest \
    --method patch \
    --url "${resource_id}?api-version=2025-01-01" \
    --headers 'Content-Type=application/json' \
    --body @- \
    --output none
}

ca_client_cert_mode_wait() {
  local resource_id="$1" expected="$2" attempts="${3:-24}" delay="${4:-5}" attempt actual
  for attempt in $(seq 1 "$attempts"); do
    actual=$(ca_client_cert_mode_get "$resource_id")
    if [ "$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')" ]; then return 0; fi
    if [ "$attempt" != "$attempts" ]; then sleep "$delay"; fi
  done
  echo "::error::Container Apps client certificate mode did not reach the expected value." >&2
  return 1
}

ca_retry_update() {
  local attempt output backoff=5 max_backoff=30
  for attempt in $(seq 1 24); do
    if output=$("$@" 2>&1); then
      printf '%s\n' "$output"
      return 0
    fi
    if ! grep -Fq 'ContainerAppOperationInProgress' <<< "$output"; then
      printf '%s\n' "$output" >&2
      return 1
    fi
    if [ "$attempt" = "24" ]; then
      printf '%s\n' "$output" >&2
      echo "::error::Container Apps operation did not release before the candidate update." >&2
      return 1
    fi
    sleep "$backoff"
    if [ "$backoff" -lt "$max_backoff" ]; then
      backoff=$((backoff * 2))
      if [ "$backoff" -gt "$max_backoff" ]; then backoff="$max_backoff"; fi
    fi
  done
}

ca_set_traffic() {
  local name="$1" revision="$2" resource_group="$3"
  [ -n "$name" ] || return 0
  [ -n "$revision" ] || { echo "::error::Cannot set traffic to an empty revision for ${name}." >&2; return 1; }
  az containerapp ingress traffic set \
    --name "$name" \
    --resource-group "$resource_group" \
    --revision-weight "$revision=100" \
    --output none
}

ca_activate_revision() {
  local name="$1" revision="$2" resource_group="$3"
  [ -n "$name" ] || return 0
  [ -n "$revision" ] || { echo "::error::Cannot activate an empty revision for ${name}." >&2; return 1; }
  az containerapp revision activate \
    --name "$name" \
    --resource-group "$resource_group" \
    --revision "$revision" \
    --output none
}

ca_rollback_revision() {
  local label="$1" name="$2" revision="$3" smoke_url="$4" resource_group="$5" attempts="${6:-30}" attempt
  [ -n "$name" ] || return 0
  ca_activate_revision "$name" "$revision" "$resource_group" || return
  ca_set_traffic "$name" "$revision" "$resource_group" || return
  for attempt in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error --max-time 5 "$smoke_url"; then
      echo "Rollback readiness passed for ${name}"
      return 0
    fi
    echo "Rollback readiness not restored for ${name} (attempt ${attempt}), retrying in 5s..."
    [ "$attempt" = "$attempts" ] || sleep 5
  done
  return 1
}

ca_deactivate_candidate() {
  local label="$1" name="$2" candidate="$3" previous="$4" resource_group="$5" weight active
  if [ -z "$name" ] || [ -z "$candidate" ] || [ "$candidate" = "$previous" ]; then return 0; fi
  weight=$(az containerapp ingress traffic show \
    --name "$name" \
    --resource-group "$resource_group" \
    --query "[?revisionName == '${candidate}'].weight | [0]" \
    --output tsv)
  if [ -n "$weight" ] && [ "$weight" != "0" ]; then
    echo "::error::${label} candidate ${candidate} still serves ${weight}% traffic; refusing to deactivate it." >&2
    return 1
  fi
  active=$(az containerapp revision show --name "$name" --resource-group "$resource_group" --revision "$candidate" --query properties.active --output tsv)
  if [ "$active" = "true" ]; then
    az containerapp revision deactivate \
      --name "$name" \
      --resource-group "$resource_group" \
      --revision "$candidate" \
      --output none
    echo "Deactivated zero-traffic ${label} candidate ${candidate}."
  fi
}

ca_deactivate_superseded() {
  local label="$1" name="$2" current="$3" rollback="$4" resource_group="$5"
  if [ -z "$name" ]; then return 0; fi
  if [ -z "$current" ] || [ -z "$rollback" ] || [ "$current" = "$rollback" ]; then
    echo "::error::${label} revision cleanup requires distinct current and rollback revisions." >&2
    return 1
  fi
  local traffic_revision traffic_weight revision weight active_count
  traffic_revision=$(az containerapp ingress traffic show \
    --name "$name" --resource-group "$resource_group" \
    --query '[?weight == `100`].revisionName | [0]' --output tsv)
  traffic_weight=$(az containerapp ingress traffic show \
    --name "$name" --resource-group "$resource_group" \
    --query "[?revisionName == '${current}'].weight | [0]" --output tsv)
  if [ "$traffic_revision" != "$current" ] || [ "$traffic_weight" != "100" ]; then
    echo "::error::${label} cleanup refused: ${current} is not the sole 100% traffic revision." >&2
    return 1
  fi
  local -a active_revisions=()
  while IFS= read -r revision; do
    [ -n "$revision" ] && active_revisions+=("$revision")
  done < <(az containerapp revision list \
    --name "$name" --resource-group "$resource_group" \
    --query '[?properties.active].name' --output tsv)
  if ! printf '%s\n' "${active_revisions[@]}" | grep -Fxq "$current" || \
     ! printf '%s\n' "${active_revisions[@]}" | grep -Fxq "$rollback"; then
    echo "::error::${label} cleanup refused: current or rollback revision is not active." >&2
    return 1
  fi
  for revision in "${active_revisions[@]}"; do
    if [ "$revision" = "$current" ] || [ "$revision" = "$rollback" ]; then continue; fi
    weight=$(az containerapp ingress traffic show \
      --name "$name" --resource-group "$resource_group" \
      --query "[?revisionName == '${revision}'].weight | [0]" --output tsv)
    if [ -n "$weight" ] && [ "$weight" != "0" ]; then
      echo "::error::${label} cleanup refused to deactivate traffic-serving revision ${revision} (${weight}%)." >&2
      return 1
    fi
    az containerapp revision deactivate \
      --name "$name" --resource-group "$resource_group" --revision "$revision" --output none
  done
  active_count=$(az containerapp revision list \
    --name "$name" --resource-group "$resource_group" \
    --query '[?properties.active] | length(@)' --output tsv)
  if [ "$active_count" != "2" ]; then
    echo "::error::${label} must retain exactly current and one rollback revision; found ${active_count}." >&2
    return 1
  fi
  echo "${label} retained current ${current} and rollback ${rollback}; superseded revisions are inactive."
}
