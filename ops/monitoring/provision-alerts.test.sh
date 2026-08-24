#!/bin/sh
set -eu

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
capture="$test_dir/az.calls"

cat >"$test_dir/az" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"${FAKE_AZ_CAPTURE:?}"
case "$*" in
  *"vm extension show"*) printf 'Succeeded\n' ;;
  *"data-collection rule association list"*) printf '%s\n' "${FAKE_DCR_COUNT:-1}" ;;
  *"data-collection rule show"*) printf '1\n' ;;
  *"log-analytics query"*"LyraShield worker starting"*) printf '%s\n' "${FAKE_WORKER_LOG_COUNT:-1}" ;;
  *"log-analytics query"*"ContainerAppConsoleLogs_CL"*) printf '%s\n' "${FAKE_APP_LOG_COUNT:-1}" ;;
  *"action-group create"*) printf '%s\n' "${FAKE_ACTION_GROUP_ID:-/subscriptions/test/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts}" ;;
  *"action-group show"*) printf 'lyrashield-operator-alerts\n' ;;
  *"metrics alert show"*"--query enabled"*) printf 'true\n' ;;
  *"metrics alert show"*"actionGroupId"*) printf '%s\n' "${FAKE_ACTION_GROUP_ID:-/subscriptions/test/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts}" ;;
  *"scheduled-query show"*"--query enabled"*) printf 'true\n' ;;
  *"scheduled-query show"*"autoMitigate"*) printf 'true\n' ;;
  *"scheduled-query show"*"actionGroups[0]"*) printf '%s\n' "${FAKE_ACTION_GROUP_ID:-/subscriptions/test/resourceGroups/rg/providers/Microsoft.Insights/actionGroups/lyrashield-operator-alerts}" ;;
esac
EOF
chmod +x "$test_dir/az"

export PATH="$test_dir:$PATH"
export FAKE_AZ_CAPTURE="$capture"
export AZURE_SUBSCRIPTION_ID=test
export AZURE_RESOURCE_GROUP=rg
export AZURE_LOCATION=centralindia
export LOG_ANALYTICS_WORKSPACE_ID=/subscriptions/test/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/logs
export LOG_ANALYTICS_WORKSPACE_GUID=00000000-0000-0000-0000-000000000001
export WORKER_DCR_ID=/subscriptions/test/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/worker
export WORKER_VM_NAME=worker
export WORKER_VM_RESOURCE_ID=/subscriptions/test/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/worker
export APP_RESOURCE_ID=/subscriptions/test/resourceGroups/rg/providers/Microsoft.App/containerApps/app
export SCANNER_RESOURCE_ID=/subscriptions/test/resourceGroups/rg/providers/Microsoft.App/containerApps/scanner
export LYRASHIELD_OPERATOR_EMAIL=operator@example.test

sh ops/monitoring/provision-alerts.sh >/dev/null

grep -q 'vm extension show.*AzureMonitorLinuxAgent' "$capture"
grep -q 'data-collection rule association list' "$capture"
grep -q 'data-collection rule show.*length(dataSources.syslog)' "$capture"
grep -q 'data-collection rule show.*workspaceResourceId' "$capture"
grep -q 'log-analytics query.*LyraShield worker starting' "$capture"
grep -q "log-analytics query.*ContainerAppConsoleLogs_CL.*_ResourceId =~ '$APP_RESOURCE_ID'" "$capture"
grep -q 'action-group create.*lyrashield-operator-alerts' "$capture"
grep -q 'worker-cpu-high.*Percentage CPU > 85.*window-size 15m' "$capture"
grep -q 'app-no-active-replica.*Replicas < 1' "$capture"
grep -q 'app-replica-restart.*RestartCount > 0' "$capture"

for code in \
  scan_queue_depth_high \
  scan_queue_oldest_wait_high \
  reconciliation_drift \
  webhook_dead_letter \
  evidence_persistence_failure \
  terminal_cost_unreconciled
do
  grep -q "$code" "$capture"
done
grep -q 'scan-readiness-unavailable.*Scan service readiness check failed' "$capture"

test "$(grep -c 'monitor scheduled-query create' "$capture")" = 7
test "$(grep -c 'monitor metrics alert create' "$capture")" = 6

worker_readback_line=$(grep -n 'log-analytics query.*LyraShield worker starting' "$capture" | cut -d: -f1)
app_readback_line=$(grep -n 'log-analytics query.*ContainerAppConsoleLogs_CL' "$capture" | cut -d: -f1)
first_mutation_line=$(grep -n 'action-group create' "$capture" | cut -d: -f1)
test "$worker_readback_line" -lt "$first_mutation_line"
test "$app_readback_line" -lt "$first_mutation_line"

# Fail before any alert mutation when AMA is absent.
sed -i.bak 's/printf '\''Succeeded\\n'\''/printf '\''Failed\\n'\''/' "$test_dir/az"
: >"$capture"
if sh ops/monitoring/provision-alerts.sh >/dev/null 2>&1; then
  echo "provisioning must fail without a healthy Azure Monitor Agent" >&2
  exit 1
fi
test "$(grep -c 'action-group create' "$capture" || true)" = 0
sed -i.bak 's/printf '\''Failed\\n'\''/printf '\''Succeeded\\n'\''/' "$test_dir/az"

# DCR configuration alone is insufficient when the actual worker stream is absent.
: >"$capture"
export FAKE_DCR_COUNT=1
export FAKE_WORKER_LOG_COUNT=0
if sh ops/monitoring/provision-alerts.sh >/dev/null 2>&1; then
  echo "provisioning must fail without recent worker application logs" >&2
  exit 1
fi
test "$(grep -c 'action-group create' "$capture" || true)" = 0

# The production app table and exact resource scope must also be live.
: >"$capture"
export FAKE_WORKER_LOG_COUNT=1
export FAKE_APP_LOG_COUNT=not-a-number
if sh ops/monitoring/provision-alerts.sh >/dev/null 2>&1; then
  echo "provisioning must fail without numeric production app log readback" >&2
  exit 1
fi
test "$(grep -c 'action-group create' "$capture" || true)" = 0

# A healthy agent without the required DCR association also fails closed.
: >"$capture"
export FAKE_DCR_COUNT=0
if sh ops/monitoring/provision-alerts.sh >/dev/null 2>&1; then
  echo "provisioning must fail without the required DCR association" >&2
  exit 1
fi
test "$(grep -c 'action-group create' "$capture" || true)" = 0

# ── Readback proof ──────────────────────────────────────────────────────────
# A fresh successful run must read back every rule and the action group.
: >"$capture"
export FAKE_DCR_COUNT=1
export FAKE_WORKER_LOG_COUNT=1
export FAKE_APP_LOG_COUNT=1
sh ops/monitoring/provision-alerts.sh >/dev/null
test "$(grep -c 'metrics alert show.*--query enabled' "$capture")" = 6
test "$(grep -c 'metrics alert show.*actionGroupId' "$capture")" = 6
test "$(grep -c 'scheduled-query show.*--query enabled' "$capture")" = 7
test "$(grep -c 'scheduled-query show.*autoMitigate' "$capture")" = 7
test "$(grep -c 'scheduled-query show.*actionGroups\[0\]' "$capture")" = 7
test "$(grep -c 'action-group show' "$capture")" = 1
for rule in \
  worker-vm-unavailable worker-cpu-high app-no-active-replica \
  app-replica-restart scanner-no-active-replica scanner-replica-restart
do
  grep -q "metrics alert show.*--name $rule" "$capture"
done
for rule in \
  scan-readiness-unavailable scan-queue-depth-high scan-queue-oldest-wait-high \
  reconciliation-drift webhook-dead-letter evidence-persistence-failure \
  terminal-cost-unreconciled
do
  grep -q "scheduled-query show.*--name $rule" "$capture"
done

# ── Inventory: every application alert code maps exactly once ───────────────
# Mirrors the OperationalAlertCode union in apps/worker/src/operational-health.ts:
# each code maps to exactly one scheduled query or metric rule; the single
# documented exception (scan_worker_lease_expired, no durable counter yet) is
# never provisioned. The metric set also includes infrastructure-only rules
# (VM availability, scanner replicas) that have no application code.
expected_scheduled="evidence-persistence-failure reconciliation-drift scan-queue-depth-high scan-queue-oldest-wait-high scan-readiness-unavailable terminal-cost-unreconciled webhook-dead-letter"
created_scheduled=$(grep 'scheduled-query create' "$capture" | sed -E 's/.*--name ([^ ]+) .*/\1/' | sort | tr '\n' ' ' | sed 's/ $//')
test "$created_scheduled" = "$expected_scheduled"
expected_metric="app-no-active-replica app-replica-restart scanner-no-active-replica scanner-replica-restart worker-cpu-high worker-vm-unavailable"
created_metric=$(grep 'metrics alert create' "$capture" | sed -E 's/.*--name ([^ ]+) .*/\1/' | sort | tr '\n' ' ' | sed 's/ $//')
test "$created_metric" = "$expected_metric"
if grep -q 'scan_worker_lease_expired' "$capture"; then
  echo "the documented lease-expiry exception must not be provisioned without a durable counter" >&2
  exit 1
fi
grep -q 'scan_worker_lease_expired' ops/monitoring/provision-alerts.sh

# ── Idempotent rerun ────────────────────────────────────────────────────────
: >"$capture"
sh ops/monitoring/provision-alerts.sh >/dev/null
test "$(grep -c 'monitor scheduled-query create' "$capture")" = 7
test "$(grep -c 'monitor metrics alert create' "$capture")" = 6
test "$(grep -c 'metrics alert show.*--query enabled' "$capture")" = 6
test "$(grep -c 'scheduled-query show.*autoMitigate' "$capture")" = 7
if grep -q 'delete' "$capture"; then
  echo "provisioning rerun must not delete or recreate rules" >&2
  exit 1
fi

# ── Empty delivery configuration fails before any mutation ──────────────────
: >"$capture"
export LYRASHIELD_OPERATOR_EMAIL=""
if sh ops/monitoring/provision-alerts.sh >/dev/null 2>&1; then
  echo "provisioning must fail with an empty operator delivery address" >&2
  exit 1
fi
test "$(grep -c 'action-group create' "$capture" || true)" = 0
unset LYRASHIELD_OPERATOR_EMAIL

# ── Query content stays code-only and bounded ───────────────────────────────
# Application log queries match structured operator_alert codes only. They
# must never match queue payloads, customer identifiers, raw errors, provider
# payloads, tokens, or broad arbitrary prose beyond the readiness transition.
if grep -nE 'job\.data|workspaceId=|Authorization|token=|error\.stack|provider payload|password=' \
  ops/monitoring/provision-alerts.sh >/dev/null; then
  echo "alert queries must not reference queue payloads, customer data, tokens, or provider payloads" >&2
  exit 1
fi
