#!/usr/bin/env bash
# A failed first transition deliberately has no automatic recovery path.
set -euo pipefail
: "${RG:?}" "${WORKER_VM_NAME:?}"
# shellcheck source=ops/deployment/azure-vm-run-command.sh
source ops/deployment/azure-vm-run-command.sh
# Shell variables and JavaScript are intentionally passed verbatim to the VM.
# shellcheck disable=SC2016
script='set -eu; receipt=/var/lib/lyrashield/v26-cutover.json; if [ ! -e "$receipt" ]; then echo V26_NO_HELD_CUTOVER; exit 0; fi; [ ! -L "$receipt" ] && [ "$(stat -c '\''%u:%a'\'' "$receipt")" = 0:600 ] || exit 1; image=$(sed -n '\''s/^LYRASHIELD_WORKER_IMAGE=//p'\'' /etc/lyrashield/worker-runtime.conf); case "$image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) exit 1;; esac; docker run --rm --network none --entrypoint node "$image" -e '\''const value=JSON.parse(process.argv[1]);if(value.kind!=="v26-accounting-cutover"||value.phase!=="COMPLETE")process.exit(1);console.log("V26_NO_HELD_CUTOVER");'\'' "$(cat "$receipt")"'
if ! result=$(azure_vm_run_command_with_retry --name "$WORKER_VM_NAME" --resource-group "$RG" --command-id RunShellScript --scripts "$script" --query 'value[0].message' --output tsv 2>&1); then
  echo '::error::v26 maintenance state is held or uncertain. Automatic retry is blocked; inspect the original receipt and repair forward deliberately.' >&2
  exit 1
fi
if [ "$(grep -Fxc V26_NO_HELD_CUTOVER <<< "$result" || true)" != 1 ]; then
  echo '::error::v26 maintenance state is held or uncertain. Automatic retry is blocked; inspect the original receipt and repair forward deliberately.' >&2
  exit 1
fi
echo 'No incomplete v26 maintenance receipt.'
