#!/usr/bin/env bash
# shellcheck disable=SC2016
set -euo pipefail
# JMESPath literals use backticks, not shell substitutions.
phase=${1:?phase}
: "${DEPLOY_SHA:?}" "${RG:?}" "${WORKER_VM_NAME:?}" "${LYRASHIELD_ADMISSION_STOP_OWNER:?}" "${LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID:?}" "${LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT:?}"
[[ "$DEPLOY_SHA" =~ ^[a-f0-9]{40}$ && "$LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID" =~ ^[0-9]+$ && "$LYRASHIELD_ADMISSION_STOP_OWNER" =~ ^[0-9]+:[0-9]+$ ]] || exit 1
[[ "$LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || exit 1
validate_recovery_inputs() {
  : "${LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID:?}" \
    "${LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER:?}" \
    "${LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA:?}" \
    "${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID:?}" \
    "${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT:?}" \
    "${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA:?}"
  [[ "$LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID" =~ ^[0-9]{1,20}$ && \
    "$LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA" =~ ^[a-f0-9]{40}$ && \
    "$LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER" =~ ^[0-9]+:[1-9][0-9]*$ && \
    "${LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER%%:*}" = "$LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID" && \
    "$LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID" = "$LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID" && \
    "$LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT" = "$LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT" && \
    "$LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA" = "$DEPLOY_SHA" && \
    "$LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID" != "$LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID" ]]
  [[ "$LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT" =~ ^[1-9][0-9]*$ ]]
}
source ops/deployment/azure-vm-run-command.sh
vm_phase() {
  local action=$1 payload env_payload command result expected_engine expected_web_image
  expected_engine=${ENGINE_REVISION:-}
  expected_web_image=${WEB_IMAGE_REFERENCE:-}
  if [[ ! "$expected_engine" =~ ^[a-f0-9]{40}$ || ! "$expected_web_image" =~ ^ghcr\.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:[a-f0-9]{64}$ ]]; then
    expected_engine=
    expected_web_image=
  fi
  payload=$(base64 < .github/scripts/webhook-claims-vm.sh | tr -d '\n')
  env_payload=$(base64 < ops/worker/worker-env.sh | tr -d '\n')
  command="set -eu; directory=\$(mktemp -d /var/lib/lyrashield/webhook-claims-run.XXXXXX); trap 'rm -rf \"\$directory\"' EXIT; printf '%s' '$env_payload' | base64 -d > \"\$directory/worker-env.sh\"; printf '%s' '$payload' | base64 -d > \"\$directory/cutover.sh\"; LYRASHIELD_WORKER_ENV_LIB=\"\$directory/worker-env.sh\" LYRASHIELD_WEBHOOK_CUTOVER_EXPECTED_ENGINE_REVISION='$expected_engine' LYRASHIELD_WEBHOOK_CUTOVER_EXPECTED_WEB_IMAGE='$expected_web_image' sh \"\$directory/cutover.sh\" '$action' '$DEPLOY_SHA' '$LYRASHIELD_ADMISSION_STOP_OWNER' '$LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID' '${MIGRATION_DATABASE_IDENTITY:-}' '$LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT' '${LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA:-}'"
  result=$(azure_vm_run_command_with_retry --name "$WORKER_VM_NAME" --resource-group "$RG" --command-id RunShellScript --scripts "$command" --query 'value[0].message' --output tsv) || return 1
  printf '%s\n' "$result"
  case "$action" in
    claim)
      encoded=$(printf '%s\n' "$result" | sed -n 's/^ADMISSION_STOP_RECEIPT_BASE64=//p')
      [[ "$encoded" =~ ^[A-Za-z0-9+/=]+$ ]] || exit 1
      value=$(printf '%s' "$encoded" | base64 -d)
      stored_owner=$(printf '%s\n' "$result" | sed -n 's/^ADMISSION_STOP_OWNER=//p')
      [[ "$stored_owner" =~ ^[0-9]+:[0-9]+$ && "$stored_owner" = "$LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID":* ]] || exit 1
      printf 'LYRASHIELD_ADMISSION_STOP_OWNER=%s\n' "$stored_owner" >> "$GITHUB_ENV"
      printf 'LYRASHIELD_ADMISSION_STOP_RECEIPT=%s\n' "$value" >> "$GITHUB_ENV"
      ;;
    stop) grep -q '^WEBHOOK_WRITERS_STOPPED$' <<< "$result" ;;
    verify) grep -q '^WEBHOOK_QUIESCENCE_VERIFIED$' <<< "$result" ;;
    database) grep -q '^WEBHOOK_MIGRATION_DATABASE_VERIFIED$' <<< "$result" ;;
    recovery) grep -q '^WEBHOOK_RECOVERY_RECEIPT_VERIFIED$' <<< "$result" ;;
    recovery-probe) grep -Eq '^WEBHOOK_RECOVERY_RECEIPT_(VERIFIED|ABSENT)$' <<< "$result" ;;
    resume) grep -q '^WEBHOOK_CUTOVER_RESUMED$' <<< "$result" ;;
    recovery-probe-new-run)
      [[ $(grep -Fxc WEBHOOK_NEW_RUN_RECOVERY_VERIFIED <<< "$result") = 1 ]] || return 1
      [[ $(grep -Fxc "WEBHOOK_RECOVERY_OWNER=$LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER" <<< "$result") = 1 ]] || return 1
      [[ $(grep -Fxc "WEBHOOK_RECOVERY_OWNER_RUN_ID=$LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID" <<< "$result") = 1 ]] || return 1
      [[ $(grep -Fxc "WEBHOOK_RECOVERY_OWNER_SOURCE_SHA=$LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA" <<< "$result") = 1 ]]
      ;;
    recovery-hold-verify) grep -Eq '^WEBHOOK_RECOVERY_HOLD_(ADMISSION_HELD|WITHOUT_ADMISSION_STOP)$' <<< "$result" ;;
    recovery-hold) grep -Eq '^WEBHOOK_RECOVERY_HOLD_(ADMISSION_HELD|WITHOUT_ADMISSION_STOP)$' <<< "$result" ;;
    resume-recovery) grep -q '^WEBHOOK_CUTOVER_ADMISSION_RELEASED$' <<< "$result" ;;
    complete-recovery) grep -q '^WEBHOOK_RECOVERY_COMPLETE$' <<< "$result" ;;
  esac
}
assert_inactive_once() {
  for name in "$APP_NAME" "$SCANNER_NAME"; do
    count=$(az containerapp revision list --name "$name" --resource-group "$RG" --query '[?properties.active==`true`] | length(@)' -o tsv) || return 1
    [[ "$count" = 0 ]] || { echo 'Incompatible writer revisions still active' >&2; return 1; }
    revisions=$(az containerapp revision list --name "$name" --resource-group "$RG" --query '[].name' -o tsv) || return 1
    for revision in $revisions; do
      count=$(az containerapp replica list --name "$name" --resource-group "$RG" --revision "$revision" --query 'length(@)' -o tsv) || return 1
      [[ "$count" = 0 ]] || { echo 'Old writer replicas still present' >&2; return 1; }
    done
  done
}
assert_inactive() {
  for attempt in $(seq 1 12); do
    if assert_inactive_once; then return 0; fi
    echo "Waiting for old writer replicas to stop (${attempt}/12)" >&2
    sleep 5
  done
  echo 'Writer quiescence readback did not converge; admission remains held' >&2
  return 1
}
assert_exact_active_revision() {
  local name=$1 inventory revision traffic
  inventory=$(az containerapp revision list --name "$name" --resource-group "$RG" --output json) || return 1
  revision=$(printf '%s' "$inventory" | node -e '
const expected=process.argv[1];
try {
  const revisions=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
  if(!Array.isArray(revisions)||revisions.length===0||revisions.some(item=>!item||typeof item.name!=="string"||!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(item.name)||![true,false].includes(item?.properties?.active)))process.exit(1);
  const active=revisions.filter(item=>item?.properties?.active===true);
  const containers=active[0]?.properties?.template?.containers;
  if(active.length!==1||!Array.isArray(containers)||containers.length!==1||containers[0]?.image!==expected)process.exit(1);
  console.log(active[0].name);
} catch { process.exit(1); }
' "$WEB_IMAGE_REFERENCE") || return 1
  traffic=$(az containerapp ingress traffic show --name "$name" --resource-group "$RG" --output json) || return 1
  printf '%s' "$traffic" | node -e '
const [revision]=process.argv.slice(1);
try {
  const traffic=JSON.parse(require("node:fs").readFileSync(0,"utf8"));
  if(!Array.isArray(traffic)||traffic.length===0||traffic.some(item=>!item||(Object.hasOwn(item,"latestRevision")&&typeof item.latestRevision!=="boolean")||item.latestRevision===true||typeof item.revisionName!=="string"||!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(item.revisionName)||!(typeof item.weight==="number"||typeof item.weight==="string")||(typeof item.weight==="string"&&!/^(0|[1-9][0-9]*)$/.test(item.weight))||!Number.isFinite(Number(item.weight))||!Number.isInteger(Number(item.weight))||Number(item.weight)<0||Number(item.weight)>100))process.exit(1);
  const weighted=traffic.filter(item=>Number(item?.weight)>0);
  if(weighted.length!==1||weighted[0]?.revisionName!==revision||Number(weighted[0]?.weight)!==100)process.exit(1);
} catch { process.exit(1); }
' "$revision"
}
assert_public_200() {
  local url=$1 attempt status
  [[ "$url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$ ]] || return 1
  for attempt in $(seq 1 12); do
    status=$(curl --proto '=https' --silent --max-time 10 --output /dev/null --write-out '%{http_code}' "$url" 2>/dev/null || true)
    [ "$status" = 200 ] && return 0
    [ "$attempt" = 12 ] || sleep 5
  done
  return 1
}
assert_completed_recovery_ready() {
  [[ "${WEB_IMAGE_REFERENCE:-}" =~ ^ghcr\.io/ecryptoguru/lyrashield-ai/lyrashield-web@sha256:[a-f0-9]{64}$ ]] || return 1
  [[ "${ENGINE_REVISION:-}" =~ ^[a-f0-9]{40}$ ]] || return 1
  [[ -n "${APP_NAME:-}" && -n "${SCANNER_NAME:-}" && -n "${APP_URL:-}" && -n "${SCANNER_URL:-}" ]] || return 1
  [[ "$APP_URL" = https://app.lyrashieldai.com && "$SCANNER_URL" = https://scanner.lyrashieldai.com ]] || return 1
  assert_exact_active_revision "$APP_NAME" || return 1
  assert_exact_active_revision "$SCANNER_NAME" || return 1
  assert_public_200 "${APP_URL%/}/api/ready" || return 1
  assert_public_200 "${SCANNER_URL%/}/api/ready" || return 1
  assert_public_200 "${APP_URL%/}/api/ready/scans" || return 1
}
completed_recovery_marker_matches() {
  local output=$1
  [[ $(grep -Fxc WEBHOOK_RECOVERY_COMPLETED_VERIFIED <<< "$output" || true) = 1 ]] || return 1
  grep -Fqx "WEBHOOK_RECOVERY_COMPLETED_ENGINE_REVISION=${ENGINE_REVISION:-}" <<< "$output" || return 1
  grep -Fqx "WEBHOOK_RECOVERY_COMPLETED_WEB_IMAGE=${WEB_IMAGE_REFERENCE:-}" <<< "$output"
}
deactivate_writers() {
  : "${APP_NAME:?}" "${SCANNER_NAME:?}"
  for name in "$APP_NAME" "$SCANNER_NAME"; do
    revisions=$(az containerapp revision list --name "$name" --resource-group "$RG" --query '[?properties.active==`true`].name' -o tsv)
    for revision in $revisions; do
      az containerapp revision deactivate --name "$name" --resource-group "$RG" --revision "$revision" -o none
    done
  done
}
case "$phase" in
hold) vm_phase recovery; vm_phase claim; deactivate_writers; assert_inactive; echo 'Maintenance failed; admission remains held. Incompatible writers were not restored.' >&2;;
database)
  MIGRATION_DATABASE_IDENTITY=$(node .github/scripts/migration-database-identity.mjs)
  vm_phase database
  ;;
recovery|recovery-probe) vm_phase "$phase";;
recovery-probe-new-run)
  validate_recovery_inputs
  vm_phase recovery-probe-new-run
  ;;
claim) vm_phase claim;;
quiesce)
  : "${APP_NAME:?}" "${SCANNER_NAME:?}"
  # Ingress is closed before the final queue drain and graceful worker stop.
  deactivate_writers
  assert_inactive
  vm_phase stop
  assert_inactive
  vm_phase verify
  ;;
verify)
  assert_inactive
  vm_phase verify
  ;;
resume) vm_phase resume;;
recovery-hold)
  validate_recovery_inputs
  : "${APP_NAME:?}" "${SCANNER_NAME:?}"
  initial=$(vm_phase recovery-hold-verify)
  initial_state=$(grep -E '^WEBHOOK_RECOVERY_HOLD_(ADMISSION_HELD|WITHOUT_ADMISSION_STOP)$' <<< "$initial")
  [[ $(grep -Fxc "$initial_state" <<< "$initial") = 1 ]] || exit 1
  completed_marker_count=$(grep -Fxc WEBHOOK_RECOVERY_COMPLETED_VERIFIED <<< "$initial" || true)
  if [[ "$initial_state" = WEBHOOK_RECOVERY_HOLD_WITHOUT_ADMISSION_STOP && "$completed_marker_count" = 1 ]] && \
    completed_recovery_marker_matches "$initial" && assert_completed_recovery_ready; then
    if final=$(vm_phase recovery-hold-verify); then
      final_state=$(grep -E '^WEBHOOK_RECOVERY_HOLD_(ADMISSION_HELD|WITHOUT_ADMISSION_STOP)$' <<< "$final" || true)
      if [[ "$final_state" = WEBHOOK_RECOVERY_HOLD_WITHOUT_ADMISSION_STOP ]] && \
        completed_recovery_marker_matches "$final" && \
        assert_exact_active_revision "$APP_NAME" && assert_exact_active_revision "$SCANNER_NAME"; then
        echo "$initial_state"
        echo WEBHOOK_RECOVERY_HOLD_ALREADY_COMPLETED
        echo WEBHOOK_RECOVERY_HOLD_COMPLETE
        exit 0
      fi
    fi
  fi
  deactivate_writers
  assert_inactive
  final=$(vm_phase recovery-hold)
  [[ $(grep -Fxc "$initial_state" <<< "$final") = 1 ]] || exit 1
  echo "$initial_state"
  echo WEBHOOK_RECOVERY_HOLD_COMPLETE
  ;;
resume-recovery)
  validate_recovery_inputs
  vm_phase resume-recovery
  ;;
complete-recovery)
  validate_recovery_inputs
  vm_phase complete-recovery
  ;;
*) exit 1;;
esac
