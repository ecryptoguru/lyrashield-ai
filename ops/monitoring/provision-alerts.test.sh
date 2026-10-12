#!/bin/sh
set -eu

python3 ops/monitoring/alert-policy.test.py

test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
capture="$test_dir/calls"
cat >"$test_dir/az" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >>"${FAKE_CAPTURE:?}"
case "$*" in
  *"vm extension show"*) printf '%s\n' "${FAKE_AMA:-Succeeded}" ;;
  *"data-collection rule association list"*) printf '%s\n' "${FAKE_DCR_COUNT:-1}" ;;
  *"data-collection rule show"*) printf '1\n' ;;
  *"resource show"*) printf '%s\n' "${FAKE_APP_IDENTITY:-app|rg|Microsoft.App/containerApps}" ;;
  *"log-analytics query"*"LyraShield worker starting"*) printf '%s\n' "${FAKE_WORKER_COUNT:-1}" ;;
  *"log-analytics query"*"ContainerAppConsoleLogs_CL"*) printf '%s\n' "${FAKE_APP_COUNT:-1}" ;;
  *) exit 1 ;;
esac
EOF
cat >"$test_dir/python3" <<'EOF'
#!/bin/sh
set -eu
printf 'policy %s\n' "$*" >>"${FAKE_CAPTURE:?}"
EOF
chmod +x "$test_dir/az" "$test_dir/python3"
export PATH="$test_dir:$PATH"
export FAKE_CAPTURE="$capture"
export AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000001
export AZURE_RESOURCE_GROUP=rg
export AZURE_LOCATION=centralindia
base=/subscriptions/$AZURE_SUBSCRIPTION_ID/resourceGroups/rg/providers
export LOG_ANALYTICS_WORKSPACE_ID=$base/Microsoft.OperationalInsights/workspaces/logs
export LOG_ANALYTICS_WORKSPACE_GUID=00000000-0000-0000-0000-000000000002
export WORKER_DCR_ID=$base/Microsoft.Insights/dataCollectionRules/worker
export WORKER_VM_NAME=worker
export WORKER_VM_RESOURCE_ID=$base/Microsoft.Compute/virtualMachines/worker
export APP_RESOURCE_ID=$base/Microsoft.App/containerApps/app
export SCANNER_RESOURCE_ID=$base/Microsoft.App/containerApps/scanner
export LYRASHIELD_PRIMARY_OPERATOR_EMAIL=operator@example.test
export LYRASHIELD_ALERT_PLAN_DIR=$test_dir/plan

sh ops/monitoring/provision-alerts.sh >/dev/null
grep -q 'policy .*alert-policy.py.*--primary-email operator@example.test.*--apply' "$capture"
grep -q 'log-analytics query.*LyraShield worker starting' "$capture"
grep -q 'log-analytics query.*ContainerAppConsoleLogs_CL' "$capture"
test "$(grep -c '^policy ' "$capture")" = 1

# Every ingestion/identity failure must stop before applying the policy.
for failure in ama dcr app-identity worker-stream app-stream; do
  : >"$capture"
  case "$failure" in
    ama) export FAKE_AMA=Failed ;;
    dcr) export FAKE_DCR_COUNT=0 ;;
    app-identity) export FAKE_APP_IDENTITY='app|other-rg|Microsoft.App/containerApps' ;;
    worker-stream) export FAKE_WORKER_COUNT=0 ;;
    app-stream) export FAKE_APP_COUNT=not-a-number ;;
  esac
  if sh ops/monitoring/provision-alerts.sh >/dev/null 2>&1; then
    echo "provisioning must fail on $failure" >&2
    exit 1
  fi
  test "$(grep -c '^policy ' "$capture" || true)" = 0
  unset FAKE_AMA FAKE_DCR_COUNT FAKE_APP_IDENTITY FAKE_WORKER_COUNT FAKE_APP_COUNT
done

: >"$capture"
export LYRASHIELD_PRIMARY_OPERATOR_EMAIL=""
if sh ops/monitoring/provision-alerts.sh >/dev/null 2>&1; then
  echo "provisioning must require an operator destination" >&2
  exit 1
fi
test "$(grep -c '^policy ' "$capture" || true)" = 0
