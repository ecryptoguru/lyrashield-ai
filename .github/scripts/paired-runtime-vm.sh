#!/usr/bin/env bash
# Dormant adapter; arguments are the protected record and Azure resource names.
# No caller-provided command, script path, endpoint, authentication or base64.
set -euo pipefail
[[ $# = 8 ]] || exit 2
owner=$1 product=$2 engine=$3 digest=$4 previous=$5 group=$6 vm=$7 vault=$8
[[ $owner =~ ^[1-9][0-9]{0,19}:[1-9][0-9]{0,9}$ && $product =~ ^[a-f0-9]{40}$ && $engine =~ ^[a-f0-9]{40}$ ]] || exit 2
[[ $digest =~ ^sha256:[a-f0-9]{64}$ && $previous =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
[[ $group =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,89}$ && $vm =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$ && $vault =~ ^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$ ]] || exit 2
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
[[ $(git rev-parse HEAD) = "$product" ]] || exit 2
repo=ghcr.io/ecryptoguru/lyrashield-ai/lyrashield-worker
# Use exact Git blobs even in a checkout with locally modified files.
payload() { git --no-replace-objects show "$product:$1" | base64 | tr -d '\n'; }
host=$(payload .github/scripts/promote-worker-vm.sh)
worker_env=$(payload ops/worker/worker-env.sh)
hold=$(payload ops/monitoring/paired-release-hold.mjs)
drain=$(payload .github/scripts/v26-execution-drain.sh)
source ops/deployment/azure-vm-run-command.sh
export AZURE_VM_RUN_COMMAND_TIMEOUT_SECONDS=1800
# Require a private per-invocation workspace and an exact terminal completion
# marker in addition to the VM promoter's held receipt. The VM extension can
# return transport success even when the guest shell exits unsuccessfully.
remote="set -eu
umask 077
d=\$(mktemp -d)
trap 'rm -f \"\$d/env.sh\" \"\$d/promote.sh\"; rmdir \"\$d\"' EXIT
printf '%s' '$worker_env' | base64 -d > \"\$d/env.sh\"
printf '%s' '$host' | base64 -d > \"\$d/promote.sh\"
[ \"\$(printf '%s' '$drain' | base64 -d | sh)\" = V26_EXECUTION_DRAIN_VERIFIED ]
LYRASHIELD_WORKER_ENV_LIB=\"\$d/env.sh\" LYRASHIELD_WORKER_GITHUB_CREDENTIAL_VAULT='$vault' LYRASHIELD_PAIRED_RELEASE_OWNER='$owner' LYRASHIELD_PAIRED_RELEASE_HOLD_MODULE_BASE64='$hold' sh \"\$d/promote.sh\" --paired-release-stopped '$repo@$previous' '$repo@$digest' '$product' '$engine'
rm -f \"\$d/env.sh\" \"\$d/promote.sh\"
rmdir \"\$d\"
trap - EXIT
printf '%s\\n' 'PAIRED_VM_COMPLETED $owner $digest'"
result=$(azure_vm_run_command_with_retry --name "$vm" --resource-group "$group" --command-id RunShellScript --scripts "$remote" --output json)
printf '%s' "$result" | node .github/scripts/paired-runtime-vm-result.mjs "$owner" "$digest"
