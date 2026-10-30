import assert from "node:assert/strict"
import { test } from "node:test"
import { planMonitoringNoiseReduction, applyMonitoringNoiseReduction } from "./reduce-noise.mjs"

const subscription = "11111111-1111-1111-1111-111111111111"
const base = `/subscriptions/${subscription}/resourceGroups/LyraShieldAI/providers`
const groupId = `${base}/Microsoft.Insights/actionGroups/lyrashield-operator-alerts`
function fixtures() {
  const metric = (name, threshold, window) => ({
    name,
    enabled: true,
    severity: 1,
    scopes: [`${base}/Microsoft.App/containerApps/lyrashield-app`],
    actions: [{ actionGroupId: groupId }],
    windowSize: window,
    evaluationFrequency: "PT1M",
    criteria: {
      allOf: [
        {
          metricName: "Requests",
          timeAggregation: "Total",
          operator: "GreaterThan",
          threshold,
          dimensions: [{ name: "statusCodeCategory", operator: "Include", values: ["5xx"] }],
        },
      ],
    },
  })
  return {
    group: {
      enabled: true,
      emailReceivers: [
        {
          name: "primary-operator",
          emailAddress: "ecryptoguru@gmail.com",
          status: "Enabled",
          useCommonAlertSchema: true,
        },
        {
          name: "founder-escalation",
          emailAddress: "ankit@lyrashieldai.com",
          status: "Enabled",
          useCommonAlertSchema: true,
        },
      ],
      otherReceiverCounts: [0],
    },
    any: metric("app-any-5xx", 0, "PT1M"),
    sustained: metric("app-http-5xx", 5, "PT5M"),
    protected: [
      "worker-vm-unavailable",
      "worker-cpu-high",
      "app-no-active-replica",
      "app-replica-restart",
      "scanner-no-active-replica",
      "scanner-replica-restart",
    ].map((name) => ({ name, enabled: true, actions: [{ actionGroupId: groupId }] })),
    cost: {
      enabled: true,
      autoMitigate: true,
      severity: 1,
      evaluationFrequency: "0:05:00",
      windowSize: "0:10:00",
      scopes: [`${base}/Microsoft.OperationalInsights/workspaces/test`],
      actions: { actionGroups: [groupId] },
      criteria: {
        allOf: [
          {
            timeAggregation: "Count",
            operator: "GreaterThan",
            threshold: 0,
            dimensions: [],
            query: "old cost query",
          },
        ],
      },
    },
  }
}
const context = { subscription, resourceGroup: "LyraShieldAI" }

test("plans exactly one receiver, one redundant email removal, and an existing cost query update", () => {
  const plan = planMonitoringNoiseReduction(fixtures(), context)
  assert.deepEqual(
    plan.map((change) => change.resource),
    ["lyrashield-operator-alerts", "app-any-5xx", "terminal-cost-unreconciled"]
  )
  assert.deepEqual(plan[0].after, [
    {
      name: "primary-operator",
      emailAddress: "ankit@lyrashieldai.com",
      useCommonAlertSchema: true,
    },
  ])
  assert.deepEqual(plan[1].after, [])
  assert.equal(plan[2].after.includes("coalesce(toscalar"), true)
})

test("the approved diff is idempotent and preserves the sustained rule", () => {
  const state = fixtures()
  for (const change of planMonitoringNoiseReduction(state, context)) {
    if (change.resource === "lyrashield-operator-alerts")
      state.group.emailReceivers = change.after.map((receiver) => ({
        ...receiver,
        status: "Enabled",
      }))
    if (change.resource === "app-any-5xx") state.any.actions = change.after
    if (change.resource === "terminal-cost-unreconciled")
      state.cost.criteria.allOf[0].query = change.after
  }
  assert.deepEqual(planMonitoringNoiseReduction(state, context), [])
  assert.equal(state.any.enabled, true)
  assert.deepEqual(state.any.actions, [])
  assert.equal(state.sustained.enabled, true)
  assert.equal(state.sustained.criteria.allOf[0].threshold, 5)
})

test("refuses drift in scopes, thresholds, receivers, and enabled outage delivery", () => {
  for (const mutate of [
    (state) => {
      state.sustained.criteria.allOf[0].threshold = 50
    },
    (state) => {
      state.sustained.scopes = [`${base}/Microsoft.App/containerApps/other`]
    },
    (state) => {
      state.sustained.enabled = false
    },
    (state) => {
      state.group.emailReceivers[1].emailAddress = "unapproved@example.test"
    },
    (state) => {
      state.group.enabled = false
    },
    (state) => {
      state.group.otherReceiverCounts = [1]
    },
  ]) {
    const state = fixtures()
    mutate(state)
    assert.throws(() => planMonitoringNoiseReduction(state, context))
  }
})

test("applies only approved property updates and rejects changed state before mutation", async () => {
  const state = fixtures()
  const plan = planMonitoringNoiseReduction(state, context)
  const calls = []
  await applyMonitoringNoiseReduction(
    plan,
    context,
    async () => state,
    async (args) => {
      calls.push(args)
    }
  )
  assert.equal(calls.length, 3)
  assert.equal(
    calls.every((args) => args.includes("update")),
    true
  )
  assert.equal(
    calls.some((args) => args.join(" ").includes("replica")),
    false
  )
  assert.equal(
    calls.some((args) => args.includes("create")),
    false
  )
  await assert.rejects(() =>
    applyMonitoringNoiseReduction(
      plan,
      context,
      async () => {
        const changed = fixtures()
        changed.sustained.enabled = false
        return changed
      },
      async () => {
        throw new Error("must not mutate")
      }
    )
  )
})

test("CLI failures emit only a bounded reason code", async () => {
  const { spawnSync } = await import("node:child_process")
  const result = spawnSync(
    process.execPath,
    [
      new URL("./reduce-noise.mjs", import.meta.url).pathname,
      "--PRIVATE_SENTINEL=PRIVATE_CREDENTIAL",
    ],
    { encoding: "utf8" }
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /monitoring\/arguments/)
  assert.doesNotMatch(result.stderr + result.stdout, /PRIVATE_SENTINEL|PRIVATE_CREDENTIAL/)
})
