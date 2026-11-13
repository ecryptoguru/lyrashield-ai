import { requireValue } from "../../packages/db/scripts/webhook-empty-state-receipt-v2.mjs"
const SUBSCRIPTION = "b2f8f58b-18f5-4e49-ac53-06ea04ff0f4c"
export function containerAppTargetArgs(resourceId) {
  const pattern = new RegExp(
    `^/subscriptions/${SUBSCRIPTION}/resourceGroups/LyraShieldAI/providers/Microsoft.App/containerApps/(lyrashield-app|lyrashield-scanner)$`,
    "i"
  )
  const target = typeof resourceId === "string" && resourceId.match(pattern)
  requireValue(target, "Unapproved fixed Container App target")
  return [
    "--subscription",
    SUBSCRIPTION,
    "--resource-group",
    "LyraShieldAI",
    "--name",
    target[1].toLowerCase(),
  ]
}
export function revisionListArgs(resourceId) {
  return [
    "containerapp",
    "revision",
    "list",
    ...containerAppTargetArgs(resourceId),
    "--all",
    "--query",
    "[].{name:name,active:properties.active,replicas:properties.replicas}",
    "-o",
    "json",
  ]
}
