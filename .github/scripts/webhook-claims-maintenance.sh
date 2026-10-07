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
  local action=$1 payload env_payload command result
  payload=$(base64 < .github/scripts/webhook-claims-vm.sh | tr -d '\n')
  env_payload=$(base64 < ops/worker/worker-env.sh | tr -d '\n')
  command="set -eu; directory=\$(mktemp -d /var/lib/lyrashield/webhook-claims-run.XXXXXX); trap 'rm -rf \"\$directory\"' EXIT; printf '%s' '$env_payload' | base64 -d > \"\$directory/worker-env.sh\"; printf '%s' '$payload' | base64 -d > \"\$directory/cutover.sh\"; LYRASHIELD_WORKER_ENV_LIB=\"\$directory/worker-env.sh\" sh \"\$directory/cutover.sh\" '$action' '$DEPLOY_SHA' '$LYRASHIELD_ADMISSION_STOP_OWNER' '$LYRASHIELD_WEBHOOK_CUTOVER_RUN_ID' '${MIGRATION_DATABASE_IDENTITY:-}' '$LYRASHIELD_WEBHOOK_CUTOVER_ATTEMPT' '${LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_RUN_ID:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_OWNER_SOURCE_SHA:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_ORIGINAL_OWNER:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_RUN_ID:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_ATTEMPT:-}' '${LYRASHIELD_WEBHOOK_CUTOVER_RECOVERY_SOURCE_SHA:-}'"
  result=$(azure_vm_run_command_with_retry --name "$WORKER_VM_NAME" --resource-group "$RG" --command-id RunShellScript --scripts "$command" --query 'value[0].message' --output tsv)
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
