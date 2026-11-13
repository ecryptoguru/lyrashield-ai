import { describe, expect, it } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import { buildScanSpendProjection } from "./scan-spend-projection"

const enginePlan = buildScanExecutionPlan({ targetType: "REPO", mode: "STANDARD" })
const deterministicPlan = buildScanExecutionPlan({ targetType: "WEB_APP", mode: "QUICK" })

const baseScan = {
  id: "scan-1",
  workspaceId: "workspace-1",
  createdById: "sponsor-1",
  sponsorAccountId: "sponsor-1",
  status: "RUNNING",
  accountingVersion: 2,
  accountingSettledAt: null,
  billedCostUsd: null,
  actualCostCents: null,
  createdAt: new Date("2026-11-05T00:00:00.000Z"),
  updatedAt: new Date("2026-11-05T00:01:00.000Z"),
  executionPlan: { ...enginePlan, limits: { ...enginePlan.limits, maxBudgetUsd: 3.2 } },
}

const capacity = {
  state: "RUNNING",
  executionStopped: false,
  admissionHeld: true,
  multiplier: 1,
  fundedMinutes: 5,
  runtimeLimitMs: 295_000,
  observedMs: 60_000,
  chargedMinutes: 0,
  absorbedMinutes: 0,
}

describe("buildScanSpendProjection", () => {
  it("keeps unreconciled spend and provider-dollar reservation explicitly unavailable", () => {
    const projection = buildScanSpendProjection({
      actorUserId: "sponsor-1",
      canManageBilling: false,
      scan: baseScan,
      capacity,
    })

    expect(projection?.maximum).toEqual({
      state: "known",
      amountUsd: "3.2",
      source: "ADMITTED_PROVIDER_CEILING",
      observedAt: "2026-11-05T00:00:00.000Z",
    })
    expect(projection?.consumed).toMatchObject({
      state: "unavailable",
      reason: "SETTLEMENT_PENDING",
    })
    expect(projection?.reserved).toEqual({
      state: "unavailable",
      reason: "NO_PROVIDER_DOLLAR_RESERVATION",
    })
    expect(projection?.agentMinutes).toMatchObject({ funded: 5, charged: 0 })
  })

  it("distinguishes an actual zero from unknown spend", () => {
    const projection = buildScanSpendProjection({
      actorUserId: "sponsor-1",
      canManageBilling: false,
      scan: {
        ...baseScan,
        status: "COMPLETED",
        accountingSettledAt: new Date("2026-11-05T00:02:00.000Z"),
        billedCostUsd: "0",
      },
      capacity: { ...capacity, state: "SETTLED", chargedMinutes: 0 },
    })

    expect(projection?.consumed).toMatchObject({
      state: "known",
      amountUsd: "0",
      source: "RECONCILED_PROVIDER_USAGE",
    })
  })

  it("reports zero provider spend for a deterministic-only scan", () => {
    const projection = buildScanSpendProjection({
      actorUserId: "sponsor-1",
      canManageBilling: false,
      scan: {
        ...baseScan,
        executionPlan: deterministicPlan,
      },
      capacity: null,
    })

    expect(projection?.maximum.state).toBe("known")
    expect(projection?.consumed).toMatchObject({ state: "known", amountUsd: "0" })
    expect(projection?.reserved).toMatchObject({ state: "not_applicable" })
    expect(projection?.agentMinutes).toBeNull()
  })

  it("allows the sponsor or a billing manager only", () => {
    expect(
      buildScanSpendProjection({
        actorUserId: "other-member",
        canManageBilling: false,
        scan: baseScan,
        capacity,
      })
    ).toBeNull()
    expect(
      buildScanSpendProjection({
        actorUserId: "billing-manager",
        canManageBilling: true,
        scan: baseScan,
        capacity,
      })
    ).not.toBeNull()
  })

  it("labels legacy scans as legacy instead of settlement pending", () => {
    const projection = buildScanSpendProjection({
      actorUserId: "sponsor-1",
      canManageBilling: false,
      scan: {
        ...baseScan,
        status: "COMPLETED",
        accountingVersion: null,
        accountingSettledAt: null,
      },
      capacity: null,
    })

    expect(projection?.consumed).toEqual({ state: "unavailable", reason: "LEGACY_SCAN" })
  })

  it.each([null, {}, { capabilities: [] }, { capabilities: ["url"], limits: {} }])(
    "does not invent zero provider spend from an unavailable execution plan: %j",
    (executionPlan) => {
      const projection = buildScanSpendProjection({
        actorUserId: "sponsor-1",
        canManageBilling: false,
        scan: {
          ...baseScan,
          status: "COMPLETED",
          accountingVersion: null,
          executionPlan,
          actualCostCents: 120,
        },
        capacity: null,
      })

      expect(projection?.maximum.state).toBe("unavailable")
      expect(projection?.reserved.state).toBe("unavailable")
      expect(projection?.consumed).toMatchObject({ state: "known", amountUsd: "1.2" })
    }
  )

  it("does not call a contradictory deterministic plan free when a provider receipt exists", () => {
    const projection = buildScanSpendProjection({
      actorUserId: "sponsor-1",
      canManageBilling: false,
      scan: { ...baseScan, executionPlan: deterministicPlan, billedCostUsd: "1.25" },
      capacity: null,
    })

    expect(projection?.maximum.state).toBe("unavailable")
    expect(projection?.reserved.state).toBe("unavailable")
    expect(projection?.consumed).toMatchObject({ state: "known", amountUsd: "1.25" })
  })

  it.each([
    {
      ...buildScanExecutionPlan({ targetType: "WEB_APP", mode: "STANDARD" }),
      capabilities: ["url"],
    },
    { ...enginePlan, capabilities: ["unknown"] },
  ])("treats a schema-valid but inconsistent capability set as unavailable", (executionPlan) => {
    const projection = buildScanSpendProjection({
      actorUserId: "sponsor-1",
      canManageBilling: false,
      scan: { ...baseScan, executionPlan },
      capacity: null,
    })
    expect(projection?.maximum.state).toBe("unavailable")
    expect(projection?.consumed.state).toBe("unavailable")
  })
})
