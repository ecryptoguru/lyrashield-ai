import { describe, expect, it } from "vitest"
import { buildScanExecutionPlan } from "@lyrashield/types"
import * as projection from "./scan-customer-usage-projection"

const scan = {
  id: "scan-1",
  workspaceId: "workspace-1",
  createdById: "sponsor-1",
  sponsorAccountId: "sponsor-1",
  status: "COMPLETED",
  accountingVersion: 2,
  accountingSettledAt: new Date("2026-11-05T00:02:00.000Z"),
  billedCostUsd: "4.83",
  actualCostCents: 483,
  createdAt: new Date("2026-11-05T00:00:00.000Z"),
  updatedAt: new Date("2026-11-05T00:02:00.000Z"),
  executionPlan: buildScanExecutionPlan({ targetType: "REPO", mode: "STANDARD" }),
}

const receipt = {
  accountId: "sponsor-1",
  workspaceId: "workspace-1",
  idempotencyKey: "workspace-1:scan-1:engine_run",
  kind: "agent_minutes",
  deletedAt: null,
  quantity: 3,
  metadata: { scanId: "scan-1", accountId: "sponsor-1" },
}

describe("customer scan usage", () => {
  it("provides a separate customer-safe projection", () => {
    expect(projection).toHaveProperty("buildCustomerScanUsageProjection")
  })

  it("reports charged minutes from the scan-bound sponsor receipt without provider cost", () => {
    const value = projection.buildCustomerScanUsageProjection({
      actorUserId: "sponsor-1",
      scan,
      receipt,
    })
    expect(value).toEqual({ state: "reconciled", chargedMinutes: 3 })
    expect(JSON.stringify(value)).not.toMatch(/4\.83|483|usd|cost|budget/i)
  })

  it("preserves unknown and pending states instead of inventing zero", () => {
    const legacy = projection.buildCustomerScanUsageProjection({
      actorUserId: "sponsor-1",
      scan: { ...scan, executionPlan: null, accountingVersion: null },
      receipt: null,
    })
    const pending = projection.buildCustomerScanUsageProjection({
      actorUserId: "sponsor-1",
      scan: { ...scan, status: "RUNNING", accountingSettledAt: null },
      receipt: null,
    })
    expect(legacy).toEqual({ state: "unavailable", chargedMinutes: null })
    expect(pending).toEqual({ state: "pending", chargedMinutes: null })
  })

  it("shows zero only for a valid deterministic plan or an actual zero receipt", () => {
    const deterministic = projection.buildCustomerScanUsageProjection({
      actorUserId: "sponsor-1",
      scan: {
        ...scan,
        executionPlan: buildScanExecutionPlan({ targetType: "WEB_APP", mode: "QUICK" }),
        billedCostUsd: null,
        actualCostCents: null,
      },
      receipt: null,
    })
    const actualZero = projection.buildCustomerScanUsageProjection({
      actorUserId: "sponsor-1",
      scan,
      receipt: { ...receipt, quantity: 0 },
    })
    expect(deterministic).toEqual({ state: "not_applicable", chargedMinutes: 0 })
    expect(actualZero).toEqual({ state: "reconciled", chargedMinutes: 0 })
  })

  it.each([
    { ...receipt, accountId: "other" },
    { ...receipt, workspaceId: "other" },
    { ...receipt, kind: "overage_minutes" },
    { ...receipt, metadata: { scanId: "other", accountId: "sponsor-1" } },
    { ...receipt, deletedAt: new Date() },
    { ...receipt, quantity: -1 },
  ])("rejects a mismatched or malformed receipt", (invalidReceipt) => {
    expect(
      projection.buildCustomerScanUsageProjection({
        actorUserId: "sponsor-1",
        scan,
        receipt: invalidReceipt,
      })
    ).toEqual({ state: "unavailable", chargedMinutes: null })
  })

  it("does not treat another workspace billing manager as the sponsor account", () => {
    expect(
      projection.buildCustomerScanUsageProjection({
        actorUserId: "other",
        scan,
        receipt,
      })
    ).toBeNull()
    expect(
      projection.buildCustomerScanUsageProjection({
        actorUserId: "sponsor-1",
        scan,
        receipt,
      })
    ).toEqual({ state: "reconciled", chargedMinutes: 3 })
  })
})
