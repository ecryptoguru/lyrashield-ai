#!/usr/bin/env bash
# The caller must hold the paired latch and prove quiescence. This action
# moves one named revision only; retiring old serving endpoints is separate.
set -euo pipefail
[[ $# = 5 ]] || exit 2
role=$1 group=$2 name=$3 revision=$4 digest=$5
case "$role" in relay) image=lyrashield-egress-proxy ;; app|scanner) image=lyrashield-web ;; *) exit 2 ;; esac
[[ $group =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,89}$ && $name =~ ^[a-z][a-z0-9-]{0,30}$ ]] || exit 2
[[ $revision =~ ^[a-z][a-z0-9-]{0,30}--[a-z0-9][a-z0-9-]{0,30}$ && $revision = "$name"--* && $digest =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source ops/deployment/containerapp.sh
expected="ghcr.io/ecryptoguru/lyrashield-ai/$image@$digest"
assert_revision() {
  az containerapp revision show --name "$name" --resource-group "$group" --revision "$revision" --output json |
    jq -e --arg rev "$revision" --arg image "$expected" '
      .name == $rev and .properties.active == true and
      .properties.healthState == "Healthy" and
      ([.properties.template.containers[].image] == [$image])' >/dev/null
}
assert_revision
ca_set_traffic "$name" "$revision" "$group"
az containerapp ingress traffic show --name "$name" --resource-group "$group" --output json |
  jq -e --arg rev "$revision" '
    type == "array" and all(.[]; (.latestRevision != true and (.label // "") == "" and
      (.weight | type) == "number" and .weight >= 0)) and
    ([.[] | select(.weight > 0) | {revisionName,weight}] == [{revisionName:$rev,weight:100}])' >/dev/null
assert_revision
