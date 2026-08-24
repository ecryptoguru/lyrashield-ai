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
: "${LYRASHIELD_OPERATOR_EMAIL:?LYRASHIELD_OPERATOR_EMAIL is required}"

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

worker_log_count=$(az_run monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_GUID" \
  --analytics-query "Syslog | where TimeGenerated > ago(24h) | where SyslogMessage has '\"message\":\"LyraShield worker starting\"' | count" \
  --query "tables[0].rows[0][0]" -o tsv)
assert_positive_count "worker application" "$worker_log_count"

app_log_count=$(az_run monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_WORKSPACE_GUID" \
  --analytics-query "ContainerAppConsoleLogs_CL | where TimeGenerated > ago(24h) | where _ResourceId =~ '$APP_RESOURCE_ID' | count" \
  --query "tables[0].rows[0][0]" -o tsv)
assert_positive_count "production app Container Apps" "$app_log_count"

action_group_id=$(az_run monitor action-group create \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name lyrashield-operator-alerts \
  --short-name LyraOps \
  --action email operator "$LYRASHIELD_OPERATOR_EMAIL" \
  --query id -o tsv)

metric_alert() {
  name=$1
  scope=$2
  condition=$3
  window=$4
  severity=$5
  az_run monitor metrics alert create \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$name" \
    --scopes "$scope" \
    --condition "$condition" \
    --evaluation-frequency 1m \
    --window-size "$window" \
    --severity "$severity" \
    --action "$action_group_id" \
    --description "LyraShield launch operational control" \
    --output none
}

metric_alert worker-vm-unavailable "$WORKER_VM_RESOURCE_ID" "min VmAvailabilityMetric < 1" 5m 1
metric_alert worker-cpu-high "$WORKER_VM_RESOURCE_ID" "avg Percentage CPU > 85" 15m 2
metric_alert app-no-active-replica "$APP_RESOURCE_ID" "min Replicas < 1" 5m 1
metric_alert app-replica-restart "$APP_RESOURCE_ID" "max RestartCount > 0" 5m 2
metric_alert scanner-no-active-replica "$SCANNER_RESOURCE_ID" "min Replicas < 1" 5m 1
metric_alert scanner-replica-restart "$SCANNER_RESOURCE_ID" "max RestartCount > 0" 5m 2

# Documented exception: scan_worker_lease_expired is intentionally NOT
# provisioned. Individual expired leases are INCONCLUSIVE because the worker
# registry prunes expired members during heartbeat refresh; total lease loss is
# covered by scan-readiness-unavailable. Provision it only after a durable
# lease-expiry counter exists.
worker_log_alert() {
  name=$1
  code=$2
  severity=$3
  query="Syslog | where TimeGenerated > ago(10m) | where SyslogMessage has '\"code\":\"${code}\"'"
  az_run monitor scheduled-query create \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location "$AZURE_LOCATION" \
    --name "$name" \
    --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
    --condition "count 'Signal' > 0" \
    --condition-query "Signal=$query" \
    --evaluation-frequency 5m \
    --window-size 10m \
    --severity "$severity" \
    --action-groups "$action_group_id" \
    --auto-mitigate true \
    --description "LyraShield operational signal: $code" \
    --output none
}

readiness_query="ContainerAppConsoleLogs_CL | where TimeGenerated > ago(10m) | where _ResourceId =~ '$APP_RESOURCE_ID' | where Log_s has '\"message\":\"Scan service readiness check failed\"' | summarize FirstSeen=min(TimeGenerated), LastSeen=max(TimeGenerated) | where LastSeen - FirstSeen > 5m"
az_run monitor scheduled-query create \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --location "$AZURE_LOCATION" \
  --name scan-readiness-unavailable \
  --scopes "$LOG_ANALYTICS_WORKSPACE_ID" \
  --condition "count 'Signal' > 0" \
  --condition-query "Signal=$readiness_query" \
  --evaluation-frequency 5m \
  --window-size 10m \
  --severity 1 \
  --action-groups "$action_group_id" \
  --auto-mitigate true \
  --description "Scan readiness unavailable for more than five minutes" \
  --output none

worker_log_alert scan-queue-depth-high scan_queue_depth_high 2
worker_log_alert scan-queue-oldest-wait-high scan_queue_oldest_wait_high 2
worker_log_alert reconciliation-drift reconciliation_drift 1
worker_log_alert webhook-dead-letter webhook_dead_letter 1
worker_log_alert evidence-persistence-failure evidence_persistence_failure 1
worker_log_alert terminal-cost-unreconciled terminal_cost_unreconciled 1

# ── Readback ────────────────────────────────────────────────────────────────
# Provisioning is not proof: after every create/update, read each rule back and
# fail unless it is enabled, auto-mitigates, and is bound to the exact operator
# action group. Azure Monitor remains the delivery/retry/resolution authority;
# these checks only prove the configuration we just wrote is live.

readback_metric_alert() {
  name=$1
  enabled=$(az_run monitor metrics alert show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$name" \
    --query enabled -o tsv)
  case "$enabled" in
    true) ;;
    *)
      echo "Metric alert $name is not enabled after provisioning" >&2
      exit 1
      ;;
  esac
  action=$(az_run monitor metrics alert show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$name" \
    --query "actions[0].actionGroupId" -o tsv)
  [ "$action" = "$action_group_id" ] || {
    echo "Metric alert $name is not bound to lyrashield-operator-alerts" >&2
    exit 1
  }
}

readback_scheduled_query() {
  name=$1
  enabled=$(az_run monitor scheduled-query show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$name" \
    --query enabled -o tsv)
  case "$enabled" in
    true) ;;
    *)
      echo "Scheduled query $name is not enabled after provisioning" >&2
      exit 1
      ;;
  esac
  auto=$(az_run monitor scheduled-query show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$name" \
    --query autoMitigate -o tsv)
  case "$auto" in
    true) ;;
    *)
      echo "Scheduled query $name does not auto-mitigate after provisioning" >&2
      exit 1
      ;;
  esac
  group=$(az_run monitor scheduled-query show \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name "$name" \
    --query "actions.actionGroups[0]" -o tsv)
  [ "$group" = "$action_group_id" ] || {
    echo "Scheduled query $name is not bound to lyrashield-operator-alerts" >&2
    exit 1
  }
}

action_readback=$(az_run monitor action-group show \
  --name lyrashield-operator-alerts \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query name -o tsv)
[ "$action_readback" = "lyrashield-operator-alerts" ] || {
  echo "Action group readback failed after provisioning" >&2
  exit 1
}

for rule in \
  worker-vm-unavailable \
  worker-cpu-high \
  app-no-active-replica \
  app-replica-restart \
  scanner-no-active-replica \
  scanner-replica-restart
do
  readback_metric_alert "$rule"
done

for rule in \
  scan-readiness-unavailable \
  scan-queue-depth-high \
  scan-queue-oldest-wait-high \
  reconciliation-drift \
  webhook-dead-letter \
  evidence-persistence-failure \
  terminal-cost-unreconciled
do
  readback_scheduled_query "$rule"
done

echo "LyraShield monitoring alerts provisioned, read back, and routed to lyrashield-operator-alerts"
