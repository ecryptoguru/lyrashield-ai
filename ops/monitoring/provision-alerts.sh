#!/bin/sh
set -eu

: "${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID is required}"
: "${AZURE_RESOURCE_GROUP:?AZURE_RESOURCE_GROUP is required}"
: "${AZURE_LOCATION:?AZURE_LOCATION is required}"
: "${LOG_ANALYTICS_WORKSPACE_ID:?LOG_ANALYTICS_WORKSPACE_ID is required}"
: "${LOG_ANALYTICS_WORKSPACE_GUID:?LOG_ANALYTICS_WORKSPACE_GUID is required}"
: "${WORKER_DCR_ID:?WORKER_DCR_ID is required}"
: "${WORKER_VM_NAME:?WORKER_VM_NAME is required}"
: "${WORKER_VM_RESOURCE_ID:?WORKER_VM_RESOURCE_ID is required}"
: "${APP_RESOURCE_ID:?APP_RESOURCE_ID is required}"
: "${SCANNER_RESOURCE_ID:?SCANNER_RESOURCE_ID is required}"
: "${LYRASHIELD_PRIMARY_OPERATOR_EMAIL:?LYRASHIELD_PRIMARY_OPERATOR_EMAIL is required}"

az_run() {
  az "$@" --subscription "$AZURE_SUBSCRIPTION_ID" --only-show-errors
}

# Log-query alerts are useless without worker log ingestion. Assert both sides
# before creating or updating any alert resource.
ama_state=$(az_run vm extension show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --vm-name "$WORKER_VM_NAME" \
  --name AzureMonitorLinuxAgent \
  --query provisioningState -o tsv)
if [ "$ama_state" != "Succeeded" ]; then
  echo "Azure Monitor Agent is not provisioned successfully on $WORKER_VM_NAME" >&2
  exit 1
fi

dcr_count=$(az_run monitor data-collection rule association list \
  --resource "$WORKER_VM_RESOURCE_ID" \
  --query "length([?dataCollectionRuleId == '$WORKER_DCR_ID'])" -o tsv)
case "$dcr_count" in
  ''|*[!0-9]*)
    echo "Could not verify a worker VM data collection rule association" >&2
    exit 1
    ;;
esac
if [ "$dcr_count" -lt 1 ]; then
  echo "Worker VM is not associated with the required data collection rule" >&2
  exit 1
fi

syslog_source_count=$(az_run monitor data-collection rule show \
  --ids "$WORKER_DCR_ID" --query "length(dataSources.syslog)" -o tsv)
workspace_destination_count=$(az_run monitor data-collection rule show \
  --ids "$WORKER_DCR_ID" \
  --query "length(destinations.logAnalytics[?workspaceResourceId == '$LOG_ANALYTICS_WORKSPACE_ID'])" \
  -o tsv)
if [ "$syslog_source_count" -lt 1 ] || [ "$workspace_destination_count" -lt 1 ]; then
  echo "Worker data collection rule must collect Syslog into LOG_ANALYTICS_WORKSPACE_ID" >&2
  exit 1
fi

assert_positive_count() {
  label=$1
  count=$2
  case "$count" in
    ''|*[!0-9]*)
      echo "Could not verify recent $label log ingestion" >&2
      exit 1
      ;;
  esac
  if [ "$count" -lt 1 ]; then
    echo "No recent $label logs found; refusing to provision dead alert rules" >&2
    exit 1
  fi
}

# Container Apps console logs arrive through the current custom-table diagnostic
# mapping with an empty _ResourceId. Resolve and validate the app identity through
# Azure before using its exact name as the log scope.
app_identity=$(az_run resource show \
  --ids "$APP_RESOURCE_ID" \
  --query "join('|', [name, resourceGroup, type])" -o tsv)
app_name=${app_identity%%|*}
app_identity_rest=${app_identity#*|}
app_resource_group=${app_identity_rest%%|*}
app_type=${app_identity_rest#*|}
if [ -z "$app_name" ] || [ "$app_resource_group" != "$AZURE_RESOURCE_GROUP" ] || [ "$app_type" != "Microsoft.App/containerApps" ]; then
  echo "APP_RESOURCE_ID must resolve to a Container App in AZURE_RESOURCE_GROUP" >&2
  exit 1
fi

worker_log_count=$(az_run monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_GUID" \
  --analytics-query "Syslog | where TimeGenerated > ago(24h) | where SyslogMessage contains '\"message\":\"LyraShield worker starting\"' | count" \
  --query "[0].Count" -o tsv)
assert_positive_count "worker application" "$worker_log_count"

app_log_count=$(az_run monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_GUID" \
  --analytics-query "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(24h) | where ContainerAppName_s =~ '$app_name' | count" \
  --query "[0].Count" -o tsv)
assert_positive_count "production app Container Apps" "$app_log_count"

# Every detector remains enabled. Urgent rules bind the single primary email;
# advisory rules have no email actions. The policy validates queries before
# mutation and reads back every declared field after applying the exact plan.
# scan_worker_lease_expired remains excluded until a durable counter exists.
plan_dir=${LYRASHIELD_ALERT_PLAN_DIR:-$(mktemp -d)}
python3 "$(dirname "$0")/alert-policy.py" \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --location "$AZURE_LOCATION" \
  --workspace-id "$LOG_ANALYTICS_WORKSPACE_ID" \
  --workspace-guid "$LOG_ANALYTICS_WORKSPACE_GUID" \
  --worker-id "$WORKER_VM_RESOURCE_ID" \
  --app-id "$APP_RESOURCE_ID" \
  --scanner-id "$SCANNER_RESOURCE_ID" \
  --primary-email "$LYRASHIELD_PRIMARY_OPERATOR_EMAIL" \
  --plan-dir "$plan_dir" --apply
