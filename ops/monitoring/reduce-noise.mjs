import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"
import { terminalCostHealthQuery } from "./terminal-cost-health-query.mjs"

const PRIMARY = "ankit@lyrashieldai.com"
const LEGACY = "ecryptoguru@gmail.com"
const PROTECTED = [
  "worker-vm-unavailable",
  "worker-cpu-high",
  "app-no-active-replica",
  "app-replica-restart",
  "scanner-no-active-replica",
  "scanner-replica-restart",
]
const receiverFields = ({ name, emailAddress, useCommonAlertSchema }) => ({
  name,
  emailAddress,
  useCommonAlertSchema,
})
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sameId = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase()

export function planMonitoringNoiseReduction(state, { subscription, resourceGroup }) {
  if (!/^[a-f0-9-]{36}$/i.test(subscription) || !/^[a-z0-9_.-]+$/i.test(resourceGroup))
    throw new Error("invalid Azure scope")
  const base = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers`
  const groupId = `${base}/Microsoft.Insights/actionGroups/lyrashield-operator-alerts`
  const appId = `${base}/Microsoft.App/containerApps/lyrashield-app`
  if (
    !state.group.enabled ||
    state.group.otherReceiverCounts.some((count) => count !== 0) ||
    state.group.emailReceivers.length < 1 ||
    state.group.emailReceivers.some(
      (receiver) =>
        ![PRIMARY, LEGACY].includes(receiver.emailAddress) ||
        receiver.status !== "Enabled" ||
        receiver.useCommonAlertSchema !== true
    )
  )
    throw new Error("operator receiver state requires review")
  for (const [rule, threshold, window] of [
    [state.any, 0, "PT1M"],
    [state.sustained, 5, "PT5M"],
  ]) {
    const condition = rule.criteria.allOf[0]
    if (
      rule.criteria.allOf.length !== 1 ||
      rule.scopes.length !== 1 ||
      !sameId(rule.scopes[0], appId) ||
      (rule === state.sustained ? rule.actions.length !== 1 : rule.actions.length > 1) ||
      rule.actions.some((action) => !sameId(action.actionGroupId, groupId)) ||
      ![1, 2].includes(rule.severity) ||
      rule.windowSize !== window ||
      rule.evaluationFrequency !== "PT1M" ||
      condition.metricName !== "Requests" ||
      condition.operator !== "GreaterThan" ||
      condition.timeAggregation !== "Total" ||
      condition.threshold !== threshold ||
      !equal(condition.dimensions, [
        { name: "statusCodeCategory", operator: "Include", values: ["5xx"] },
      ])
    )
      throw new Error("5xx coverage changed; review before mutation")
  }
  if (!state.any.enabled) throw new Error("individual-error detector must remain enabled")
  if (!state.sustained.enabled) throw new Error("sustained 5xx outage delivery must remain enabled")
  for (const name of PROTECTED) {
    const rule = state.protected.find((rule) => rule.name === name)
    if (
      !rule?.enabled ||
      (["worker-vm-unavailable", "app-no-active-replica", "scanner-no-active-replica"].includes(
        name
      ) &&
        !rule.actions.some((action) => sameId(action.actionGroupId, groupId)))
    )
      throw new Error("protected operational delivery requires review")
  }
  const cost = state.cost
  const condition = cost.criteria.allOf[0]
  if (
    !cost.enabled ||
    !cost.autoMitigate ||
    cost.criteria.allOf.length !== 1 ||
    condition.timeAggregation !== "Count" ||
    condition.operator !== "GreaterThan" ||
    condition.threshold !== 0 ||
    (condition.dimensions ?? []).length !== 0 ||
    cost.scopes.length !== 1 ||
    !cost.scopes[0]
      .toLowerCase()
      .startsWith(`${base}/Microsoft.OperationalInsights/workspaces/`.toLowerCase()) ||
    cost.actions.actionGroups.length !== 1 ||
    !sameId(cost.actions.actionGroups[0], groupId) ||
    cost.evaluationFrequency !== "0:05:00" ||
    !["0:10:00", "6:00:00"].includes(cost.windowSize) ||
    cost.severity !== 1
  )
    throw new Error("cost alert state requires review")
  const plan = []
  const receivers = [
    { name: "primary-operator", emailAddress: PRIMARY, useCommonAlertSchema: true },
  ]
  const currentReceivers = state.group.emailReceivers.map(receiverFields)
  if (!equal(currentReceivers, receivers))
    plan.push({
      resource: "lyrashield-operator-alerts",
      property: "emailReceivers",
      before: currentReceivers,
      after: receivers,
    })
  if (state.any.actions.length)
    plan.push({
      resource: "app-any-5xx",
      property: "actions",
      before: state.any.actions,
      after: [],
    })
  const query = terminalCostHealthQuery(
    `${base}/Microsoft.Compute/virtualMachines/lyrashield-worker`
  )
  if (condition.query !== query)
    plan.push({
      resource: "terminal-cost-unreconciled",
      property: "criteria.allOf[0].query",
      before: condition.query,
      after: query,
    })
  return plan
}

export async function applyMonitoringNoiseReduction(plan, context, read, run) {
  if (!equal(planMonitoringNoiseReduction(await read(), context), plan))
    throw new Error("live state changed since planning")
  for (const change of plan) {
    const current = planMonitoringNoiseReduction(await read(), context).find(
      (item) => item.resource === change.resource
    )
    if (!current) continue
    if (!equal(current, change)) throw new Error("live state changed before property update")
    const command =
      change.resource === "lyrashield-operator-alerts"
        ? ["monitor", "action-group"]
        : change.resource === "app-any-5xx"
          ? ["monitor", "metrics", "alert"]
          : ["monitor", "scheduled-query"]
    const value = typeof change.after === "string" ? change.after : JSON.stringify(change.after)
    await run([
      ...command,
      "update",
      "--subscription",
      context.subscription,
      "--resource-group",
      context.resourceGroup,
      "--name",
      change.resource,
      "--set",
      `${change.property}=${value}`,
      "--output",
      "none",
      "--only-show-errors",
    ])
  }
}

function az(args) {
  return execFileSync("az", args, {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function main() {
  const { values } = parseArgs({
    options: {
      subscription: { type: "string" },
      "resource-group": { type: "string" },
      apply: { type: "boolean", default: false },
    },
  })
  const context = { subscription: values.subscription, resourceGroup: values["resource-group"] }
  if (!context.subscription || !context.resourceGroup)
    throw new Error("--subscription and --resource-group are required")
  const scope = [
    "--subscription",
    context.subscription,
    "--resource-group",
    context.resourceGroup,
    "--output",
    "json",
    "--only-show-errors",
  ]
  const read = async () => {
    const group = JSON.parse(
      az([
        "monitor",
        "action-group",
        "show",
        "--name",
        "lyrashield-operator-alerts",
        ...scope,
        "--query",
        "{enabled:enabled,emailReceivers:emailReceivers,otherReceiverCounts:[length(smsReceivers),length(webhookReceivers),length(azureFunctionReceivers),length(voiceReceivers),length(logicAppReceivers),length(armRoleReceivers),length(automationRunbookReceivers),length(azureAppPushReceivers),length(eventHubReceivers),length(itsmReceivers)]}",
      ])
    )
    const metrics = JSON.parse(az(["monitor", "metrics", "alert", "list", ...scope]))
    const cost = JSON.parse(
      az(["monitor", "scheduled-query", "show", "--name", "terminal-cost-unreconciled", ...scope])
    )
    return {
      group,
      any: metrics.find((rule) => rule.name === "app-any-5xx"),
      sustained: metrics.find((rule) => rule.name === "app-http-5xx"),
      protected: metrics.filter((rule) => PROTECTED.includes(rule.name)),
      cost,
    }
  }
  const before = await read()
  const plan = planMonitoringNoiseReduction(before, context)
  console.log(JSON.stringify({ mode: values.apply ? "apply" : "plan", changes: plan }, null, 2))
  if (!values.apply) return
  await applyMonitoringNoiseReduction(plan, context, read, async (args) => {
    az(args)
  })
  const after = await read()
  if (
    planMonitoringNoiseReduction(after, context).length ||
    !equal(before.protected, after.protected) ||
    !equal(before.sustained, after.sustained)
  )
    throw new Error("readback failed; inspect the partial live state before retrying")
  console.log(
    JSON.stringify({
      status: "verified",
      primaryInbox: PRIMARY,
      changedResources: plan.map((change) => change.resource),
      protectedRulesUnchanged: true,
      sustained5xxUnchanged: true,
    })
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      "Monitoring update failed; no credentials or raw Azure error were printed. Inspect live state before retrying."
    )
    process.exitCode = 1
  })
}
