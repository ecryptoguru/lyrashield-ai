import { describe, expect, it } from "vitest"
import { buildScanSpendProjection } from "./scan-spend-projection"

const baseScan = {
  id: "scan-1",
  createdById: "sponsor-1",
  sponsorAccountId: "sponsor-1",
  status: "RUNNING",
  accountingVersion: 2,
  accountingSettledAt: null,
  billedCostUsd: null,
  actualCostCents: null,
  createdAt: new Date("2026-11-05T00:00:00.000Z"),
  updatedAt: new Date("2026-11-05T00:01:00.000Z"),
  executionPlan: {
    capabilities: ["engine"],
    limits: { maxBudgetUsd: 3.2 },
  },
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
        executionPlan: { capabilities: ["sast", "secrets"], limits: {} },
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
})
